export type TelegramThemePreference = 'light' | 'dark';

interface TelegramThemePreferenceRecord {
  theme: TelegramThemePreference;
  updatedAt: number;
}

const PREFERENCE_TTL_MS = 1000 * 60 * 60 * 48;
const preferences = new Map<string, TelegramThemePreferenceRecord>();

function normalizeConversationId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : null;
}

function isExpired(record: TelegramThemePreferenceRecord, now = Date.now()): boolean {
  return now - record.updatedAt > PREFERENCE_TTL_MS;
}

export function rememberTelegramThemePreference(
  conversationId: string,
  theme: TelegramThemePreference,
): void {
  const normalizedConversationId = normalizeConversationId(conversationId);
  if (!normalizedConversationId) {
    return;
  }

  preferences.set(normalizedConversationId, {
    theme,
    updatedAt: Date.now(),
  });
}

export function getTelegramThemePreference(
  conversationId: string | null | undefined,
): TelegramThemePreference | null {
  const normalizedConversationId = normalizeConversationId(conversationId);
  if (!normalizedConversationId) {
    return null;
  }

  const record = preferences.get(normalizedConversationId) ?? null;
  if (!record) {
    return null;
  }

  if (isExpired(record)) {
    preferences.delete(normalizedConversationId);
    return null;
  }

  return record.theme;
}

export function clearTelegramThemePreferences(): void {
  preferences.clear();
}
