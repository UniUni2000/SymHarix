import { describe, expect, test } from 'bun:test';
import { parseDistributionCommand } from './distribution';

describe('downloaded package launcher', () => {
  test('starts configuration by default and exposes configuration shortcuts', () => {
    expect(parseDistributionCommand([])).toEqual({ kind: 'configure', args: [] });
    expect(parseDistributionCommand(['config', 'models'])).toEqual({ kind: 'configure', args: ['models'] });
    expect(parseDistributionCommand(['configure', 'telegram'])).toEqual({ kind: 'configure', args: ['telegram'] });
    expect(parseDistributionCommand(['doctor'])).toEqual({ kind: 'configure', args: ['--doctor'] });
    expect(parseDistributionCommand(['guide'])).toEqual({ kind: 'configure', args: ['--guide'] });
    expect(parseDistributionCommand(['access', 'copy', 'viewer'])).toEqual({
      kind: 'access',
      args: ['copy', 'viewer'],
    });
  });

  test('uses numbered product surfaces without leaking them into service arguments', () => {
    expect(parseDistributionCommand(['start', 'telegram', '--port=4000'])).toEqual({
      kind: 'start',
      surface: 'telegram',
      args: ['--port=4000'],
    });
    expect(parseDistributionCommand(['start', 'feishu'])).toEqual({
      kind: 'start',
      surface: 'feishu',
      args: [],
    });
  });

  test('passes advanced service commands through unchanged', () => {
    expect(parseDistributionCommand(['repair', 'all'])).toEqual({
      kind: 'service',
      args: ['repair', 'all'],
    });
  });
});
