export type ConfigurationIssueSeverity = 'error' | 'warning';

export interface ConfigurationFormatIssue {
  field: string;
  severity: ConfigurationIssueSeverity;
  message: string;
}

type EnvValues = Record<string, string | undefined>;

function valueOf(env: EnvValues, key: string): string {
  const current = env[key]?.trim();
  if (current) return current;
  if (key.startsWith('SYMHARIX_')) {
    return env[`SYMPHONY_${key.slice('SYMHARIX_'.length)}`]?.trim() ?? '';
  }
  return '';
}

function issue(
  field: string,
  severity: ConfigurationIssueSeverity,
  message: string,
): ConfigurationFormatIssue {
  return { field, severity, message };
}

function validateSecret(
  field: string,
  value: string,
  options: { minLength?: number; prefixes?: string[] } = {},
): ConfigurationFormatIssue[] {
  if (!value) return [];
  const issues: ConfigurationFormatIssue[] = [];
  if (/\s/.test(value)) {
    issues.push(issue(field, 'error', `${field} 不能包含空格或换行；请确认没有复制到首尾空格。`));
  }
  if (value.length < (options.minLength ?? 16)) {
    issues.push(issue(field, 'error', `${field} 长度异常，可能只复制了部分内容。`));
  }
  if (options.prefixes?.length && !options.prefixes.some((prefix) => value.startsWith(prefix))) {
    issues.push(issue(
      field,
      'warning',
      `${field} 不是当前常见前缀 ${options.prefixes.join(' / ')}；如果平台刚升级了格式，可继续交给联网 doctor 验证。`,
    ));
  }
  return issues;
}

function validateCommaSeparated(
  field: string,
  value: string,
  matcher: RegExp,
  expected: string,
): ConfigurationFormatIssue[] {
  if (!value) return [];
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !matcher.test(part))) {
    return [issue(field, 'error', `${field} 应为${expected}；多人使用英文逗号分隔。`)];
  }
  return [];
}

function validateBaseUrl(field: string, value: string): ConfigurationFormatIssue[] {
  if (!value) return [];
  try {
    const parsed = new URL(value);
    const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
      return [issue(field, 'error', `${field} 必须使用 HTTPS；只有 localhost/127.0.0.1 可以使用 HTTP。`)];
    }
    if (parsed.username || parsed.password) {
      return [issue(field, 'error', `${field} 不能在 URL 中内嵌用户名或密码。`)];
    }
    return [];
  } catch {
    return [issue(field, 'error', `${field} 不是有效 URL，例如 https://provider.example/v1。`)];
  }
}

export function validateConfigurationField(field: string, rawValue: string): ConfigurationFormatIssue[] {
  const value = rawValue.trim();
  switch (field) {
    case 'SYMHARIX_TRACKER_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['lin_api_'] });
    case 'GITHUB_TOKEN':
      return validateSecret(field, value, {
        minLength: 20,
        // Fine-grained/classic PATs plus GitHub OAuth, App user, and App
        // installation access tokens. Refresh tokens (`ghr_`) are not API
        // bearer tokens and deliberately remain outside this list.
        prefixes: ['github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_'],
      });
    case 'ANTHROPIC_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['sk-ant-'] });
    case 'OPENAI_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['sk-', 'sk-proj-'] });
    case 'GOOGLE_GENERATIVE_AI_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['AIza'] });
    case 'DEEPSEEK_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['sk-'] });
    case 'OPENROUTER_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['sk-or-'] });
    case 'DASHSCOPE_API_KEY':
      return validateSecret(field, value, { minLength: 20, prefixes: ['sk-'] });
    case 'SYMHARIX_OPENCODE_API_KEY':
    case 'SYMHARIX_BOT_LLM_API_KEY':
      return validateSecret(field, value, { minLength: 16 });
    case 'SYMHARIX_RUNTIME_WRITE_TOKEN':
    case 'SYMHARIX_RUNTIME_VIEWER_TOKEN':
    case 'SYMHARIX_RUNTIME_SESSION_SECRET':
    case 'SYMHARIX_TELEGRAM_WEBHOOK_SECRET':
      return validateSecret(field, value, { minLength: 32 });
    case 'SYMHARIX_TELEGRAM_BOT_TOKEN':
      return value && !/^\d{6,14}:[A-Za-z0-9_-]{20,}$/.test(value)
        ? [issue(field, 'error', 'Telegram bot token 格式应为“数字:长字符串”；请从官方 @BotFather 重新复制。')]
        : [];
    case 'SYMHARIX_TELEGRAM_OPERATOR_IDS':
      return validateCommaSeparated(field, value, /^\d+$/, '一个或多个 Telegram numeric user ID');
    case 'SYMHARIX_FEISHU_APP_ID':
      return value && !/^cli_[A-Za-z0-9]+$/.test(value)
        ? [issue(field, 'error', '飞书 App ID 应以 cli_ 开头；不要填 App Secret 或 tenant key。')]
        : [];
    case 'SYMHARIX_FEISHU_APP_SECRET':
      return validateSecret(field, value, { minLength: 16 });
    case 'SYMHARIX_FEISHU_OPERATOR_IDS':
      return validateCommaSeparated(field, value, /^ou_[A-Za-z0-9]+$/, '一个或多个以 ou_ 开头的飞书 open_id');
    case 'SYMHARIX_OPENCODE_MODEL':
      return value && !/^[A-Za-z0-9][A-Za-z0-9._-]*\/.+/.test(value)
        ? [issue(field, 'error', '代码模型必须使用 provider/model 格式，例如 deepseek/deepseek-chat。')]
        : [];
    case 'SYMHARIX_BOT_LLM_MODEL':
      return value && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || /\s/.test(value))
        ? [issue(field, 'error', '聊天模型名称只能包含字母、数字、点、下划线、冒号、斜杠和连字符。')]
        : [];
    case 'SYMHARIX_OPENCODE_BASE_URL':
    case 'SYMHARIX_BOT_LLM_BASE_URL':
    case 'SYMHARIX_PUBLIC_BASE_URL':
    case 'OPENAI_BASE_URL':
    case 'ANTHROPIC_BASE_URL':
      return validateBaseUrl(field, value);
    case 'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES': {
      if (!value) return [];
      const ttl = Number(value);
      return !Number.isInteger(ttl) || ttl < 1 || ttl > 1440
        ? [issue(field, 'error', 'Runtime session TTL 必须是 1 到 1440 分钟的整数。')]
        : [];
    }
    case 'SYMHARIX_MAX_TURN_OUTPUT_TOKENS':
    case 'SYMHARIX_MAX_TURN_STEPS':
    case 'SYMHARIX_TURN_RESERVE_TOKENS':
    case 'SYMHARIX_MAX_TASK_TOKENS':
    case 'SYMHARIX_MAX_REPO_DAILY_TOKENS':
    case 'SYMHARIX_MAX_DAILY_TOKENS':
    case 'SYMHARIX_COST_OVERRIDE_MINUTES': {
      if (!value) return [];
      const parsed = Number(value);
      return !Number.isSafeInteger(parsed) || parsed <= 0
        ? [issue(field, 'error', `${field} 必须是正整数。`)]
        : [];
    }
    case 'SYMHARIX_MAX_TASK_USD':
    case 'SYMHARIX_MAX_REPO_DAILY_USD':
    case 'SYMHARIX_MAX_DAILY_USD':
    case 'SYMHARIX_COST_INPUT_USD_PER_MILLION':
    case 'SYMHARIX_COST_OUTPUT_USD_PER_MILLION':
    case 'SYMHARIX_COST_CACHE_READ_USD_PER_MILLION': {
      if (!value) return [];
      const parsed = Number(value);
      return !Number.isFinite(parsed) || parsed <= 0
        ? [issue(field, 'error', `${field} 必须是大于 0 的数字。`)]
        : [];
    }
    default:
      return [];
  }
}

const VALIDATED_FIELDS = [
  'SYMHARIX_TRACKER_API_KEY',
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'DASHSCOPE_API_KEY',
  'SYMHARIX_OPENCODE_API_KEY',
  'SYMHARIX_BOT_LLM_API_KEY',
  'SYMHARIX_RUNTIME_WRITE_TOKEN',
  'SYMHARIX_RUNTIME_VIEWER_TOKEN',
  'SYMHARIX_RUNTIME_SESSION_SECRET',
  'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES',
  'SYMHARIX_TELEGRAM_BOT_TOKEN',
  'SYMHARIX_TELEGRAM_WEBHOOK_SECRET',
  'SYMHARIX_TELEGRAM_OPERATOR_IDS',
  'SYMHARIX_FEISHU_APP_ID',
  'SYMHARIX_FEISHU_APP_SECRET',
  'SYMHARIX_FEISHU_OPERATOR_IDS',
  'SYMHARIX_OPENCODE_MODEL',
  'SYMHARIX_BOT_LLM_MODEL',
  'SYMHARIX_OPENCODE_BASE_URL',
  'SYMHARIX_BOT_LLM_BASE_URL',
  'SYMHARIX_PUBLIC_BASE_URL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'SYMHARIX_MAX_TURN_OUTPUT_TOKENS',
  'SYMHARIX_MAX_TURN_STEPS',
  'SYMHARIX_TURN_RESERVE_TOKENS',
  'SYMHARIX_MAX_TASK_TOKENS',
  'SYMHARIX_MAX_REPO_DAILY_TOKENS',
  'SYMHARIX_MAX_DAILY_TOKENS',
  'SYMHARIX_COST_OVERRIDE_MINUTES',
  'SYMHARIX_MAX_TASK_USD',
  'SYMHARIX_MAX_REPO_DAILY_USD',
  'SYMHARIX_MAX_DAILY_USD',
  'SYMHARIX_COST_INPUT_USD_PER_MILLION',
  'SYMHARIX_COST_OUTPUT_USD_PER_MILLION',
  'SYMHARIX_COST_CACHE_READ_USD_PER_MILLION',
] as const;

export function validateConfigurationFormats(env: EnvValues): ConfigurationFormatIssue[] {
  const issues = VALIDATED_FIELDS.flatMap((field) => (
    validateConfigurationField(field, valueOf(env, field))
  ));

  const writeToken = valueOf(env, 'SYMHARIX_RUNTIME_WRITE_TOKEN');
  const viewerToken = valueOf(env, 'SYMHARIX_RUNTIME_VIEWER_TOKEN');
  const sessionSecret = valueOf(env, 'SYMHARIX_RUNTIME_SESSION_SECRET');
  if (writeToken && viewerToken && writeToken === viewerToken) {
    issues.push(issue(
      'SYMHARIX_RUNTIME_VIEWER_TOKEN',
      'error',
      'Runtime viewer token 不能与 operator token 相同，否则 viewer 会获得写权限。',
    ));
  }
  if (sessionSecret && (sessionSecret === writeToken || sessionSecret === viewerToken)) {
    issues.push(issue(
      'SYMHARIX_RUNTIME_SESSION_SECRET',
      'error',
      'Runtime session secret 必须与 viewer/operator token 不同。',
    ));
  }

  const model = valueOf(env, 'SYMHARIX_OPENCODE_MODEL');
  const provider = valueOf(env, 'SYMHARIX_OPENCODE_PROVIDER');
  if (model && provider && model.split('/')[0] !== provider) {
    issues.push(issue(
      'SYMHARIX_OPENCODE_PROVIDER',
      'error',
      `SYMHARIX_OPENCODE_PROVIDER=${provider} 与模型的 provider 前缀不一致。`,
    ));
  }

  const inputRate = valueOf(env, 'SYMHARIX_COST_INPUT_USD_PER_MILLION');
  const outputRate = valueOf(env, 'SYMHARIX_COST_OUTPUT_USD_PER_MILLION');
  if (Boolean(inputRate) !== Boolean(outputRate)) {
    issues.push(issue(
      'SYMHARIX_COST_INPUT_USD_PER_MILLION',
      'warning',
      '美元护栏只有同时配置 input/output 每百万 token 价格才会启用；当前只配置了一项。',
    ));
  }
  return issues;
}
