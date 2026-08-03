import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  defaultInstalledSymHarixHome,
  resolveSymHarixApplicationRoot,
  resolveSymHarixHome,
} from './installationPaths';

describe('installation paths', () => {
  test('keeps source checkout behavior when install variables are absent', () => {
    expect(resolveSymHarixApplicationRoot('/repo', {})).toBe(path.resolve('/repo'));
    expect(resolveSymHarixHome('/repo', {})).toBe(path.resolve('/repo'));
  });

  test('separates immutable application files from mutable user data', () => {
    const env = {
      SYMHARIX_APP_ROOT: '/opt/symharix/v1',
      SYMHARIX_HOME: '/home/user/.symharix',
    };
    expect(resolveSymHarixApplicationRoot('/repo', env)).toBe(path.resolve('/opt/symharix/v1'));
    expect(resolveSymHarixHome('/repo', env)).toBe(path.resolve('/home/user/.symharix'));
  });

  test('uses a per-user data directory for downloaded packages', () => {
    expect(defaultInstalledSymHarixHome('darwin', { HOME: '/Users/demo' }))
      .toBe('/Users/demo/.symharix');
    expect(defaultInstalledSymHarixHome('win32', { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' }))
      .toBe(path.join('C:\\Users\\demo\\AppData\\Local', 'SymHarix'));
  });
});
