function normalizeEnvValue(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isEphemeralTryCloudflareUrl(value: string | null): boolean {
  return Boolean(value && /^https:\/\/[a-z0-9.-]+trycloudflare\.com\/?$/i.test(value));
}

export function buildTelegramStartupSummary(telegram: {
  health?: string | null;
  webhook_url?: string | null;
  webhook_last_error_message?: string | null;
}): string {
  const webhookUrl = normalizeEnvValue(telegram.webhook_url ?? undefined) ?? '(none)';
  const status = webhookUrl === '(none)' ? 'unhealthy' : 'healthy';
  const error = normalizeEnvValue(telegram.webhook_last_error_message ?? undefined);
  if (error) {
    return `telegram: ${status} webhook_url=${webhookUrl} error=${error}`;
  }
  return `telegram: ${status} webhook_url=${webhookUrl}`;
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
    return false;
  }
  if (expectedBaseUrl && webhookUrl && !webhookUrl.startsWith(`${expectedBaseUrl}/`)) {
    return false;
  }
  if (webhookUrl) {
    return true;
  }
  return false;
}

export function shouldProvisionStartLocalTunnel(
  env: Record<string, string | undefined>,
): boolean {
  if (!normalizeEnvValue(env.SYMPHONY_TELEGRAM_BOT_TOKEN)) {
    return false;
  }
  if (normalizeEnvValue(env.SYMPHONY_TELEGRAM_BOOTSTRAP)?.toLowerCase() === 'off') {
    return false;
  }
  const publicBaseUrl = normalizeEnvValue(env.SYMPHONY_PUBLIC_BASE_URL);
  if (publicBaseUrl && !isEphemeralTryCloudflareUrl(publicBaseUrl)) {
    return false;
  }
  return true;
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
