import type { BotCommandContext } from './types';

export interface BotOperatorAllowlists {
  telegramOperatorIds: ReadonlySet<string>;
  discordOperatorIds: ReadonlySet<string>;
  feishuOperatorIds: ReadonlySet<string>;
}

/**
 * Bot writes are fail-closed. An enabled transport without an operator allowlist
 * remains useful for read-only chat, but cannot create, approve, or control work.
 */
export function createBotWriteAuthorizer(
  allowlists: BotOperatorAllowlists,
): (context: BotCommandContext) => boolean {
  return (context) => {
    const operatorIds = context.transport === 'telegram'
      ? allowlists.telegramOperatorIds
      : context.transport === 'feishu'
        ? allowlists.feishuOperatorIds
        : allowlists.discordOperatorIds;
    return Boolean(
      operatorIds.size > 0
      && context.identity.user_id
      && operatorIds.has(context.identity.user_id),
    );
  };
}
