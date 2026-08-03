import { describe, expect, test } from 'bun:test';
import { createBotWriteAuthorizer } from './access';
import type { BotCommandContext, BotTransport } from './types';

function context(transport: BotTransport, userId: string | null): BotCommandContext {
  return {
    transport,
    conversation_id: 'conversation-1',
    identity: {
      user_id: userId,
      display_name: null,
    },
  };
}

describe('createBotWriteAuthorizer', () => {
  test('denies writes when a transport allowlist is empty', () => {
    const canWrite = createBotWriteAuthorizer({
      telegramOperatorIds: new Set(),
      feishuOperatorIds: new Set(),
      discordOperatorIds: new Set(),
    });

    expect(canWrite(context('telegram', '9'))).toBe(false);
    expect(canWrite(context('feishu', 'ou_user'))).toBe(false);
    expect(canWrite(context('discord', 'user-1'))).toBe(false);
  });

  test('allows only explicitly configured operators', () => {
    const canWrite = createBotWriteAuthorizer({
      telegramOperatorIds: new Set(['9']),
      feishuOperatorIds: new Set(['ou_user']),
      discordOperatorIds: new Set(['user-1']),
    });

    expect(canWrite(context('telegram', '9'))).toBe(true);
    expect(canWrite(context('feishu', 'ou_user'))).toBe(true);
    expect(canWrite(context('discord', 'user-1'))).toBe(true);
    expect(canWrite(context('telegram', '10'))).toBe(false);
    expect(canWrite(context('telegram', null))).toBe(false);
  });
});
