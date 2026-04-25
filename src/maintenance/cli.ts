export interface MaintenanceCommand {
  kind: 'repair_bot_followups' | 'repair_all';
}

export type MaintenanceCommandParseResult =
  | {
      ok: true;
      command: MaintenanceCommand;
    }
  | {
      ok: false;
      error: string;
    };

export function parseMaintenanceArgs(args: string[]): MaintenanceCommandParseResult {
  if (args[0] === 'bot-followups' && args.length === 1) {
    return {
      ok: true,
      command: {
        kind: 'repair_bot_followups',
      },
    };
  }

  if (args[0] === 'all' && args.length === 1) {
    return {
      ok: true,
      command: {
        kind: 'repair_all',
      },
    };
  }

  return {
    ok: false,
    error: 'repair requires a supported subcommand: bot-followups | all',
  };
}
