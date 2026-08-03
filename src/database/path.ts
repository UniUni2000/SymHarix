import { existsSync } from 'node:fs';
import * as path from 'node:path';

export const CURRENT_DATABASE_FILENAME = 'symharix.db';
export const LEGACY_DATABASE_FILENAME = 'symphony.db';

/**
 * New installations use the SymHarix name. Existing installations continue
 * using the legacy file in place so upgrades never appear to lose history.
 */
export function resolveDefaultDatabasePath(projectRoot: string): string {
  const currentPath = path.join(projectRoot, CURRENT_DATABASE_FILENAME);
  if (existsSync(currentPath)) {
    return currentPath;
  }
  const legacyPath = path.join(projectRoot, LEGACY_DATABASE_FILENAME);
  return existsSync(legacyPath) ? legacyPath : currentPath;
}
