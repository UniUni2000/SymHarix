import { logger } from '../logging';
import type { TelegramCallbackAuditRecord, TelegramWebhookDiagnostics } from './types';
import { createDefaultTelegramApiFetch } from './telegramHttp';

const CALLBACK_OK_WINDOW_MS = 15 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000;
const WEBHOOK_ERROR_WINDOW_MS = 15 * 60 * 1000;
const PENDING_UPDATE_DEGRADED_THRESHOLD = 5;

interface TelegramWebhookInfoPayload {
  result?: {
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    last_error_date?: number;
  };
}

export interface TelegramWebhookDiagnosticsService {
  getSnapshot(): TelegramWebhookDiagnostics;
  maybeRefresh(): void;
  refreshNow(): Promise<void>;
  recordIngressSuccess(): void;
  recordCallbackSuccess(): void;
  recordCallbackFailure(error?: Error | null): void;
  recordAudit(record: TelegramCallbackAuditRecord): void;
}

function toIsoTimestamp(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function isRecentWebhookError(
  message: string | null,
  timestamp: string | null,
  nowMs: number,
  errorWindowMs: number,
): boolean {
  if (!message) {
    return false;
  }
  if (!timestamp) {
    return true;
  }
  const parsed = Date.parse(timestamp);
  return !Number.isFinite(parsed) || nowMs - parsed <= errorWindowMs;
}

function deriveHealth(
  snapshot: Omit<TelegramWebhookDiagnostics, 'health'>,
  pendingUpdateThreshold = PENDING_UPDATE_DEGRADED_THRESHOLD,
): TelegramWebhookDiagnostics['health'] {
  if (!snapshot.webhook_url) {
    return 'unconfigured';
  }
  if (
    snapshot.diagnostics_error_message ||
    snapshot.webhook_error_recent ||
    (snapshot.webhook_pending_update_count ?? 0) >= pendingUpdateThreshold
  ) {
    return 'degraded';
  }
  return 'healthy';
}

export class DefaultTelegramWebhookDiagnosticsService implements TelegramWebhookDiagnosticsService {
  private snapshot: TelegramWebhookDiagnostics;
  private lastRefreshAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  private lastCallbackSuccessAt = 0;
  private lastIngressSuccessAt = 0;
  private readonly recentAudits: TelegramCallbackAuditRecord[] = [];

  constructor(
    private readonly botToken: string | null,
    private readonly fetcher: typeof fetch = createDefaultTelegramApiFetch(),
    private readonly options: {
      now?: () => number;
      refreshIntervalMs?: number;
      webhookErrorWindowMs?: number;
      pendingUpdateThreshold?: number;
    } = {},
  ) {
    this.snapshot = {
      health: botToken ? 'degraded' : 'unconfigured',
      webhook_url: null,
      webhook_pending_update_count: null,
      webhook_last_error_message: null,
      webhook_last_error_at: null,
      webhook_error_recent: false,
      diagnostics_error_message: null,
      diagnostics_checked_at: null,
      webhook_ingress_recently_ok: false,
      callback_ingress_recently_ok: false,
    };
  }

  getSnapshot(): TelegramWebhookDiagnostics {
    const now = this.options.now?.() ?? Date.now();
    const callbackIngressRecentlyOk =
      this.lastCallbackSuccessAt > 0 &&
      now - this.lastCallbackSuccessAt <= CALLBACK_OK_WINDOW_MS;
    const webhookIngressRecentlyOk =
      this.lastIngressSuccessAt > 0 &&
      now - this.lastIngressSuccessAt <= CALLBACK_OK_WINDOW_MS;
    const webhookErrorRecent = isRecentWebhookError(
      this.snapshot.webhook_last_error_message,
      this.snapshot.webhook_last_error_at,
      now,
      this.options.webhookErrorWindowMs ?? WEBHOOK_ERROR_WINDOW_MS,
    );
    const next = {
      ...this.snapshot,
      webhook_error_recent: webhookErrorRecent,
      webhook_ingress_recently_ok: webhookIngressRecentlyOk,
      callback_ingress_recently_ok: callbackIngressRecentlyOk,
    };
    return {
      ...next,
      health: deriveHealth(
        next,
        Math.max(1, this.options.pendingUpdateThreshold ?? PENDING_UPDATE_DEGRADED_THRESHOLD),
      ),
    };
  }

  maybeRefresh(): void {
    if (!this.botToken) {
      return;
    }
    if (this.refreshInFlight) {
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    if (now - this.lastRefreshAt < (this.options.refreshIntervalMs ?? REFRESH_INTERVAL_MS)) {
      return;
    }

    this.refreshInFlight = this.refresh().finally(() => {
      this.refreshInFlight = null;
    });
  }

  async refreshNow(): Promise<void> {
    if (!this.botToken) {
      return;
    }

    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }

    this.refreshInFlight = this.refresh().finally(() => {
      this.refreshInFlight = null;
    });
    await this.refreshInFlight;
  }

  recordIngressSuccess(): void {
    this.lastIngressSuccessAt = this.options.now?.() ?? Date.now();
    this.snapshot = {
      ...this.snapshot,
      webhook_ingress_recently_ok: true,
    };
  }

  recordCallbackSuccess(): void {
    const now = this.options.now?.() ?? Date.now();
    this.lastCallbackSuccessAt = now;
    this.lastIngressSuccessAt = now;
    this.snapshot = {
      ...this.snapshot,
      webhook_ingress_recently_ok: true,
      callback_ingress_recently_ok: true,
    };
  }

  recordCallbackFailure(error?: Error | null): void {
    const message = error?.message ?? null;
    this.snapshot = {
      ...this.snapshot,
      webhook_last_error_message: this.snapshot.webhook_last_error_message ?? message,
      webhook_last_error_at: message ? new Date().toISOString() : this.snapshot.webhook_last_error_at,
    };
  }

  recordAudit(record: TelegramCallbackAuditRecord): void {
    this.recentAudits.push(record);
    if (this.recentAudits.length > 200) {
      this.recentAudits.splice(0, this.recentAudits.length - 200);
    }

    const logContext = {
      callback_id: record.callback_id,
      chat_id: record.chat_id,
      message_id: record.message_id,
      callback_data: record.callback_data,
      issue_id: record.issue_id,
      action_kind: record.action_kind,
      result: record.result,
      error_message: record.error_message,
    };

    if (record.result === 'failed') {
      logger.error('Telegram callback failed', logContext, record.error_message ? new Error(record.error_message) : undefined);
      return;
    }

    logger.info('Telegram callback event', logContext);
  }

  private async refresh(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    this.lastRefreshAt = now;
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/getWebhookInfo`,
      );
      if (!response.ok) {
        throw new Error(`Telegram getWebhookInfo failed with status ${response.status}`);
      }

      const payload = await response.json() as TelegramWebhookInfoPayload;
      const next = {
        webhook_url: payload.result?.url ?? null,
        webhook_pending_update_count: payload.result?.pending_update_count ?? 0,
        webhook_last_error_message: payload.result?.last_error_message ?? null,
        webhook_last_error_at: toIsoTimestamp(payload.result?.last_error_date),
        webhook_error_recent: false,
        diagnostics_error_message: null,
        diagnostics_checked_at: new Date(now).toISOString(),
        webhook_ingress_recently_ok: this.getSnapshot().webhook_ingress_recently_ok,
        callback_ingress_recently_ok: this.getSnapshot().callback_ingress_recently_ok,
      };

      next.webhook_error_recent = isRecentWebhookError(
        next.webhook_last_error_message,
        next.webhook_last_error_at,
        now,
        this.options.webhookErrorWindowMs ?? WEBHOOK_ERROR_WINDOW_MS,
      );

      this.snapshot = {
        ...next,
        health: deriveHealth(
          next,
          Math.max(1, this.options.pendingUpdateThreshold ?? PENDING_UPDATE_DEGRADED_THRESHOLD),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown diagnostics error';
      this.snapshot = {
        ...this.snapshot,
        diagnostics_error_message: message,
        diagnostics_checked_at: new Date(now).toISOString(),
      };
      logger.warn('Telegram webhook diagnostics refresh failed', {
        error_message: message,
      }, error instanceof Error ? error : undefined);
    }
  }
}
