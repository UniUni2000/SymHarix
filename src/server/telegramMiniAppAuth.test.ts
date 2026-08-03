import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { validateTelegramMiniAppInitData } from './telegramMiniAppAuth';

function signedInitData(params: {
  botToken: string;
  authDate: number;
  userId: string;
  firstName?: string;
}): string {
  const values = new URLSearchParams({
    auth_date: String(params.authDate),
    query_id: 'AAE-test-query',
    user: JSON.stringify({
      id: Number(params.userId),
      first_name: params.firstName ?? 'Operator',
    }),
  });
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(params.botToken)
    .digest();
  values.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return values.toString();
}

describe('Telegram Mini App authentication', () => {
  const botToken = '123456789:test-bot-token';
  const now = new Date('2026-08-03T07:30:00.000Z');
  const authDate = Math.floor(now.getTime() / 1000);

  test('accepts a fresh Telegram-signed configured operator', () => {
    const result = validateTelegramMiniAppInitData(signedInitData({
      botToken,
      authDate,
      userId: '8552378102',
      firstName: 'Jasper',
    }), {
      botToken,
      operatorIds: new Set(['8552378102']),
      now: () => now,
    });

    expect(result).toMatchObject({
      ok: true,
      userId: '8552378102',
      displayName: 'Jasper',
    });
  });

  test('rejects tampered, expired, and non-operator initData', () => {
    const valid = signedInitData({ botToken, authDate, userId: '8552378102' });
    const tampered = valid.replace('8552378102', '8552378103');
    expect(validateTelegramMiniAppInitData(tampered, {
      botToken,
      operatorIds: new Set(['8552378102']),
      now: () => now,
    })).toMatchObject({ ok: false, status: 401 });

    expect(validateTelegramMiniAppInitData(signedInitData({
      botToken,
      authDate: authDate - 301,
      userId: '8552378102',
    }), {
      botToken,
      operatorIds: new Set(['8552378102']),
      now: () => now,
    })).toMatchObject({ ok: false, status: 401, error: 'Telegram initData has expired.' });

    expect(validateTelegramMiniAppInitData(signedInitData({
      botToken,
      authDate,
      userId: '7',
    }), {
      botToken,
      operatorIds: new Set(['8552378102']),
      now: () => now,
    })).toMatchObject({ ok: false, status: 403 });
  });
});
