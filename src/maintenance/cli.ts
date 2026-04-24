export interface MaintenanceCommand {
  kind: 'repair_bot_followups';
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

  return {
    ok: false,
    error: 'repair requires the supported subcommand: bot-followups',
  };
}
