import { describe, expect, test } from 'bun:test';
import { parseMaintenanceArgs } from './cli';

describe('parseMaintenanceArgs', () => {
  test('parses the bot follow-up repair maintenance command', () => {
    expect(parseMaintenanceArgs(['bot-followups'])).toEqual({
      ok: true,
      command: {
        kind: 'repair_bot_followups',
      },
    });
  });

  test('parses the all-in-one maintenance repair command', () => {
    expect(parseMaintenanceArgs(['all'])).toEqual({
      ok: true,
      command: {
        kind: 'repair_all',
      },
    });
  });

  test('fails closed when the repair subcommand is missing or unsupported', () => {
    const parsed = parseMaintenanceArgs([]);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error('expected repair parser to fail closed');
    }
    expect(parsed.error).toContain('bot-followups');
  });
});
