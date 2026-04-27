export interface VerifyLiveLifecycleCommand {
  projectSlug: string;
  timeoutMs: number | null;
  json: boolean;
  titleSuffix: string | null;
  supervisorScenario?: boolean;
  serverUrl?: string | null;
  telegramChatId?: string | null;
  supervisorLiveScenario?: 'simple' | 'governed_split' | 'destructive_cleanup' | null;
  supervisorLiveMatrix?: boolean;
}

export type VerifyLiveLifecycleArgsParseResult =
  | {
      ok: true;
      command: VerifyLiveLifecycleCommand;
    }
  | {
      ok: false;
      error: string;
    };

export function parseVerifyLiveLifecycleArgs(args: string[]): VerifyLiveLifecycleArgsParseResult {
  let projectSlug: string | null = null;
  let timeoutMs: number | null = null;
  let json = false;
  let titleSuffix: string | null = null;
  let serverUrl: string | null = null;
  let telegramChatId: string | null = null;
  let supervisorLiveScenario: VerifyLiveLifecycleCommand['supervisorLiveScenario'] = null;
  let supervisorLiveMatrix = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project-slug' && args[index + 1]) {
      projectSlug = args[index + 1]!.trim() || null;
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms' && args[index + 1]) {
      const parsed = Number.parseInt(args[index + 1]!, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: 'verify-live-lifecycle requires a positive integer for --timeout-ms.',
        };
      }
      timeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--title-suffix' && args[index + 1]) {
      titleSuffix = args[index + 1]!.trim() || null;
      index += 1;
      continue;
    }

    if (arg === '--server-url' && args[index + 1]) {
      serverUrl = args[index + 1]!.trim().replace(/\/+$/, '') || null;
      index += 1;
      continue;
    }

    if (arg === '--telegram-chat-id' && args[index + 1]) {
      telegramChatId = args[index + 1]!.trim() || null;
      index += 1;
      continue;
    }

    if (arg === '--scenario' && args[index + 1]) {
      const normalized = args[index + 1]!.trim().replace(/-/g, '_');
      if (!['simple', 'governed_split', 'destructive_cleanup'].includes(normalized)) {
        return {
          ok: false,
          error: 'verify-live-supervisor --scenario must be one of simple, governed-split, destructive-cleanup.',
        };
      }
      supervisorLiveScenario = normalized as NonNullable<VerifyLiveLifecycleCommand['supervisorLiveScenario']>;
      index += 1;
      continue;
    }

    if (arg === '--matrix') {
      supervisorLiveMatrix = true;
      continue;
    }

    return {
      ok: false,
      error: `Unknown verify-live-lifecycle argument: ${arg}`,
    };
  }

  if (!projectSlug) {
    return {
      ok: false,
      error: 'verify-live-lifecycle requires --project-slug <slug>.',
    };
  }

  const command: VerifyLiveLifecycleCommand = {
    projectSlug,
    timeoutMs,
    json,
    titleSuffix,
  };
  if (serverUrl) {
    command.serverUrl = serverUrl;
  }
  if (telegramChatId) {
    command.telegramChatId = telegramChatId;
  }
  if (supervisorLiveScenario) {
    command.supervisorLiveScenario = supervisorLiveScenario;
  }
  if (supervisorLiveMatrix) {
    command.supervisorLiveMatrix = true;
  }

  return { ok: true, command };
}

export function parseVerifyLiveSupervisorArgs(args: string[]): VerifyLiveLifecycleArgsParseResult {
  const parsed = parseVerifyLiveLifecycleArgs(args);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error.replace('verify-live-lifecycle', 'verify-live-supervisor'),
    };
  }
  return {
    ok: true,
    command: {
      ...parsed.command,
      supervisorScenario: true,
      titleSuffix: parsed.command.titleSuffix ?? `supervisor-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    },
  };
}

export function shouldRunAttachedVerifierBeforeServiceBootstrap(command: VerifyLiveLifecycleCommand): boolean {
  return Boolean(command.json && command.serverUrl);
}
