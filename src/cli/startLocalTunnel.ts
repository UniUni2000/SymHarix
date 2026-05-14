import { readSymHarixEnvTrimmed } from '../config/env';

function normalizeEnvValue(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isEphemeralTryCloudflareUrl(value: string | null): boolean {
  return Boolean(value && /^https:\/\/[a-z0-9.-]+trycloudflare\.com\/?$/i.test(value));
}

function isRecoverableTunnelWebhookError(value: string | null): boolean {
  return Boolean(value && /530|wrong response from the webhook|cloudflare|tunnel|failed to resolve host|host.*not known|dns|timed out|connection reset|fetch failed|network error/i.test(value));
}

export function buildTelegramStartupSummary(telegram: {
  health?: string | null;
  webhook_url?: string | null;
  webhook_last_error_message?: string | null;
  public_base_url?: string | null;
  webhook_pending_update_count?: number | null;
}, expectedPublicBaseUrl?: string | null): string {
  const webhookUrl = normalizeEnvValue(telegram.webhook_url ?? undefined) ?? '(none)';
  const expectedBaseUrl = normalizeEnvValue(expectedPublicBaseUrl ?? undefined);
  const currentBaseUrl = normalizeEnvValue(telegram.public_base_url ?? undefined);
  const staleWebhook = Boolean(expectedBaseUrl && webhookUrl !== '(none)' && !webhookUrl.startsWith(`${expectedBaseUrl}/`));
  const status = staleWebhook
    ? 'stale'
    : webhookUrl === '(none)'
      ? 'unhealthy'
      : telegram.health ?? 'healthy';
  const error = normalizeEnvValue(telegram.webhook_last_error_message ?? undefined);
  const details = [`webhook_url=${webhookUrl}`];
  if (expectedBaseUrl) {
    details.push(`expected_base=${expectedBaseUrl}`);
  }
  if (currentBaseUrl && currentBaseUrl !== expectedBaseUrl) {
    details.push(`public_base=${currentBaseUrl}`);
  }
  if (typeof telegram.webhook_pending_update_count === 'number' && telegram.webhook_pending_update_count > 0) {
    details.push(`pending_updates=${telegram.webhook_pending_update_count}`);
  }
  if (error) {
    details.push(`error=${error}`);
  }
  return `telegram: ${status} ${details.join(' ')}`;
}

export function shouldEmitTelegramStartupSummary(telegram: {
  health?: string | null;
  webhook_url?: string | null;
  webhook_last_error_message?: string | null;
  public_base_url?: string | null;
}, expectedPublicBaseUrl?: string | null): boolean {
  const expectedBaseUrl = normalizeEnvValue(expectedPublicBaseUrl ?? undefined);
  const currentBaseUrl = normalizeEnvValue(telegram.public_base_url ?? undefined);
  const webhookUrl = normalizeEnvValue(telegram.webhook_url ?? undefined);
  if (expectedBaseUrl && currentBaseUrl && expectedBaseUrl !== currentBaseUrl) {
    return true;
  }
  if (expectedBaseUrl && webhookUrl && !webhookUrl.startsWith(`${expectedBaseUrl}/`)) {
    return true;
  }
  if (webhookUrl) {
    return true;
  }
  if (normalizeEnvValue(telegram.webhook_last_error_message ?? undefined)) {
    return true;
  }
  return false;
}

export function getStartLocalTunnelRecoveryReason(telegram: {
  health?: string | null;
  webhook_url?: string | null;
  webhook_last_error_message?: string | null;
  public_base_url?: string | null;
  webhook_pending_update_count?: number | null;
}, expectedPublicBaseUrl?: string | null): string | null {
  const expectedBaseUrl = normalizeEnvValue(expectedPublicBaseUrl ?? undefined);
  if (!isEphemeralTryCloudflareUrl(expectedBaseUrl)) {
    return null;
  }

  const webhookUrl = normalizeEnvValue(telegram.webhook_url ?? undefined);
  if (webhookUrl && !webhookUrl.startsWith(`${expectedBaseUrl}/`)) {
    return `stale webhook_url=${webhookUrl} expected_base=${expectedBaseUrl}`;
  }

  const currentBaseUrl = normalizeEnvValue(telegram.public_base_url ?? undefined);
  if (currentBaseUrl && currentBaseUrl !== expectedBaseUrl) {
    return `stale public_base=${currentBaseUrl} expected_base=${expectedBaseUrl}`;
  }

  const error = normalizeEnvValue(telegram.webhook_last_error_message ?? undefined);
  if (isRecoverableTunnelWebhookError(error)) {
    return `telegram webhook degraded: ${error}`;
  }

  if (
    telegram.health === 'degraded' &&
    typeof telegram.webhook_pending_update_count === 'number' &&
    telegram.webhook_pending_update_count > 0 &&
    error
  ) {
    return `telegram webhook degraded: ${error}`;
  }

  return null;
}

export function getStartLocalTunnelProbeRecoveryReason(params: {
  expectedPublicBaseUrl?: string | null;
  status?: number | null;
  errorMessage?: string | null;
}): string | null {
  const expectedBaseUrl = normalizeEnvValue(params.expectedPublicBaseUrl ?? undefined);
  if (!isEphemeralTryCloudflareUrl(expectedBaseUrl)) {
    return null;
  }

  const errorMessage = normalizeEnvValue(params.errorMessage ?? undefined);
  if (errorMessage) {
    return `public tunnel unreachable: ${errorMessage}`;
  }

  if (typeof params.status === 'number' && params.status >= 500) {
    return `public tunnel unreachable: status ${params.status}`;
  }

  return null;
}

export function shouldProvisionStartLocalTunnel(
  env: Record<string, string | undefined>,
): boolean {
  if (!readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_BOT_TOKEN', env)) {
    return false;
  }
  if (readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_BOOTSTRAP', env)?.toLowerCase() === 'off') {
    return false;
  }
  const publicBaseUrl = readSymHarixEnvTrimmed('SYMPHONY_PUBLIC_BASE_URL', env);
  if (publicBaseUrl && !isEphemeralTryCloudflareUrl(publicBaseUrl)) {
    return false;
  }
  return true;
}

export function hasHttpProxyEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(
    normalizeEnvValue(env.HTTP_PROXY)
      || normalizeEnvValue(env.HTTPS_PROXY)
      || normalizeEnvValue(env.http_proxy)
      || normalizeEnvValue(env.https_proxy),
  );
}

export function applyProxyEnv(
  env: Record<string, string | undefined>,
  proxyUrl: string,
): void {
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.http_proxy = proxyUrl;
  env.https_proxy = proxyUrl;
}

export function disableProxyEnv(env: Record<string, string | undefined>): void {
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
}

export function ensureNoProxyForLocalhost(env: Record<string, string | undefined>): void {
  if (!normalizeEnvValue(env.NO_PROXY) && !normalizeEnvValue(env.no_proxy)) {
    env.NO_PROXY = '127.0.0.1,localhost';
  }
}

export function upsertEnvAssignment(
  source: string,
  key: string,
  value: string,
): string {
  const assignment = `${key}=${value}`;
  const lines = source.split(/\r?\n/);
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?)${key}=.*$`);

  let replaced = false;
  const updated = lines.map((line) => {
    const match = line.match(pattern);
    if (!match || replaced) {
      return line;
    }
    replaced = true;
    return `${match[1] ?? ''}${assignment}`;
  });

  const normalized = updated.at(-1) === ''
    ? updated.slice(0, -1)
    : updated;

  if (!replaced) {
    normalized.push(assignment);
  }

  return `${normalized.join('\n')}\n`;
}

export function resolveStartLocalPort(
  args: string[],
  env: Record<string, string | undefined>,
  workflowServerPort?: number | null,
): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      break;
    }
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      break;
    }
  }

  const envPort = Number.parseInt(env.PORT ?? '', 10);
  if (Number.isFinite(envPort) && envPort > 0) {
    return envPort;
  }

  if (typeof workflowServerPort === 'number' && Number.isFinite(workflowServerPort) && workflowServerPort > 0) {
    return workflowServerPort;
  }

  return 3000;
}
