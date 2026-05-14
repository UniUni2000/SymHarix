type EnvMap = Record<string, string | undefined>;

const LEGACY_PREFIX = 'SYMPHONY_';
const CURRENT_PREFIX = 'SYMHARIX_';

export function symHarixEnvName(legacyName: string): string {
  if (!legacyName.startsWith(LEGACY_PREFIX)) {
    throw new Error(`Expected ${LEGACY_PREFIX} environment variable name, got ${legacyName}`);
  }
  return `${CURRENT_PREFIX}${legacyName.slice(LEGACY_PREFIX.length)}`;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readSymHarixEnv(
  legacyName: string,
  env: EnvMap = process.env,
): string | undefined {
  const currentName = symHarixEnvName(legacyName);
  const currentValue = env[currentName];
  if (hasValue(currentValue)) {
    return currentValue;
  }
  return env[legacyName];
}

export function readSymHarixEnvTrimmed(
  legacyName: string,
  env: EnvMap = process.env,
): string | null {
  const value = readSymHarixEnv(legacyName, env)?.trim();
  return value ? value : null;
}

export function setSymHarixEnv(
  legacyName: string,
  value: string,
  env: EnvMap = process.env,
): void {
  env[legacyName] = value;
  env[symHarixEnvName(legacyName)] = value;
}

export function deleteSymHarixEnv(
  legacyName: string,
  env: EnvMap = process.env,
): void {
  delete env[legacyName];
  delete env[symHarixEnvName(legacyName)];
}

export function syncSymHarixEnvAliases(env: EnvMap = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(CURRENT_PREFIX) || !hasValue(value)) {
      continue;
    }
    const legacyName = `${LEGACY_PREFIX}${name.slice(CURRENT_PREFIX.length)}`;
    env[legacyName] = value;
  }
}
