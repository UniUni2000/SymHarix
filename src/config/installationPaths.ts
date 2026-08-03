import * as os from 'node:os';
import * as path from 'node:path';

type Environment = Record<string, string | undefined>;

function configuredPath(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? path.resolve(normalized) : null;
}

/** Resolve immutable application resources (src, scripts, templates, runtime lock). */
export function resolveSymHarixApplicationRoot(
  sourceRoot: string,
  env: Environment = process.env,
): string {
  return configuredPath(env.SYMHARIX_APP_ROOT) ?? path.resolve(sourceRoot);
}

/** Resolve mutable operator data (.env, WORKFLOW.md, database, workspaces). */
export function resolveSymHarixHome(
  applicationRoot: string,
  env: Environment = process.env,
): string {
  return configuredPath(env.SYMHARIX_HOME) ?? path.resolve(applicationRoot);
}

/** Default home used by downloaded release packages. Source checkouts stay in-place. */
export function defaultInstalledSymHarixHome(
  platform = process.platform,
  env: Environment = process.env,
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, 'SymHarix');
  }
  return path.join(env.HOME?.trim() || os.homedir(), '.symharix');
}
