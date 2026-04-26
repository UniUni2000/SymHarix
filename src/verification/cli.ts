export interface VerifyLiveLifecycleCommand {
  projectSlug: string;
  timeoutMs: number | null;
  json: boolean;
  titleSuffix: string | null;
  supervisorScenario?: boolean;
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

  return {
    ok: true,
    command: {
      projectSlug,
      timeoutMs,
      json,
      titleSuffix,
    },
  };
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
      titleSuffix: parsed.command.titleSuffix ?? 'supervisor-e2e',
    },
  };
}
