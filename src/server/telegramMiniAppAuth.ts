import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSymHarixEnv } from '../config/env';

const DEFAULT_MAX_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_SKEW_SECONDS = 30;

export interface TelegramMiniAppAuthConfig {
  botToken: string;
  operatorIds: ReadonlySet<string>;
  maxAgeSeconds?: number;
  now?: () => Date;
}

export type TelegramMiniAppAuthResult =
  | {
      ok: true;
      userId: string;
      displayName: string | null;
      authDate: Date;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 503;
      error: string;
    };

function safeHexMatch(presented: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(presented)) {
    return false;
  }
  const left = Buffer.from(presented.toLowerCase(), 'hex');
  const right = Buffer.from(expected.toLowerCase(), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseOperatorIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^\d+$/.test(part)),
  );
}

export function createTelegramMiniAppAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TelegramMiniAppAuthConfig | null {
  const botToken = readSymHarixEnv('SYMPHONY_TELEGRAM_BOT_TOKEN', env)?.trim();
  if (!botToken) {
    return null;
  }
  return {
    botToken,
    operatorIds: parseOperatorIds(
      readSymHarixEnv('SYMPHONY_TELEGRAM_OPERATOR_IDS', env),
    ),
  };
}

export function validateTelegramMiniAppInitData(
  initData: string,
  config: TelegramMiniAppAuthConfig,
): TelegramMiniAppAuthResult {
  const normalized = initData.trim();
  if (!normalized || normalized.length > 16 * 1024) {
    return { ok: false, status: 400, error: 'Telegram initData is missing or too large.' };
  }
  if (!config.botToken.trim()) {
    return { ok: false, status: 503, error: 'Telegram Mini App authentication is not configured.' };
  }

  const params = new URLSearchParams(normalized);
  const presentedHash = params.get('hash')?.trim() ?? '';
  if (!presentedHash) {
    return { ok: false, status: 401, error: 'Telegram initData signature is missing.' };
  }
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(config.botToken)
    .digest();
  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  if (!safeHexMatch(presentedHash, expectedHash)) {
    return { ok: false, status: 401, error: 'Telegram initData signature is invalid.' };
  }

  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isInteger(authDateSeconds) || authDateSeconds <= 0) {
    return { ok: false, status: 401, error: 'Telegram initData auth_date is invalid.' };
  }
  const nowSeconds = Math.floor((config.now?.() ?? new Date()).getTime() / 1000);
  const maxAgeSeconds = Math.max(30, Math.trunc(config.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS));
  if (
    authDateSeconds < nowSeconds - maxAgeSeconds
    || authDateSeconds > nowSeconds + MAX_FUTURE_SKEW_SECONDS
  ) {
    return { ok: false, status: 401, error: 'Telegram initData has expired.' };
  }

  let user: Record<string, unknown>;
  try {
    user = JSON.parse(params.get('user') ?? '') as Record<string, unknown>;
  } catch {
    return { ok: false, status: 401, error: 'Telegram initData user is invalid.' };
  }
  const userId = typeof user.id === 'number' || typeof user.id === 'string'
    ? String(user.id)
    : '';
  if (!/^\d+$/.test(userId)) {
    return { ok: false, status: 401, error: 'Telegram initData user id is invalid.' };
  }
  if (!config.operatorIds.has(userId)) {
    return { ok: false, status: 403, error: 'This Telegram user is not a configured SymHarix operator.' };
  }

  const displayName = [user.first_name, user.last_name]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join(' ') || (typeof user.username === 'string' ? `@${user.username}` : null);
  return {
    ok: true,
    userId,
    displayName,
    authDate: new Date(authDateSeconds * 1000),
  };
}
