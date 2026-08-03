export type DoctorStatus = 'pass' | 'fail' | 'skip';

export interface DoctorResult {
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DiscoveredLinearProject {
  id: string;
  name: string;
  slug: string;
}

export interface ConfigurationDoctorInput {
  linearApiKey: string;
  linearEndpoint?: string;
  linearProjectSlug: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  runtimeProvider: string;
  runtimeApiKey: string;
  runtimeBaseUrl?: string;
  usesOpenCodeAuth: boolean;
  telegramToken?: string;
  telegramPublicBaseUrl?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
}

export interface ConfigurationDoctorOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  linearEndpoint?: string;
}

export interface GitHubRepositoryProbeInput {
  token: string;
  owner: string;
  repo: string;
}

const LINEAR_PROJECT_QUERY = `
  query SymHarixSetupDoctor {
    projects(first: 100) {
      nodes { id name slugId }
    }
  }
`;

function fetchOptions(options: ConfigurationDoctorOptions): {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
} {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
  };
}

function safeFailure(label: string, reason: unknown): DoctorResult {
  const message = reason instanceof Error && reason.name === 'TimeoutError'
    ? '连接超时；检查网络、代理或服务区域。'
    : '连接失败；检查网络、代理或服务地址。';
  return { label, status: 'fail', detail: message };
}

async function readJson(response: Response): Promise<Record<string, any> | null> {
  return response.json().catch(() => null) as Promise<Record<string, any> | null>;
}

export async function discoverLinearProjects(
  apiKey: string,
  options: ConfigurationDoctorOptions = {},
): Promise<{ ok: true; projects: DiscoveredLinearProject[] } | { ok: false; error: string }> {
  if (!apiKey) return { ok: false, error: '未提供 Linear API key。' };
  const { fetchImpl, signal } = fetchOptions(options);
  try {
    const response = await fetchImpl(options.linearEndpoint || 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: LINEAR_PROJECT_QUERY }),
      signal,
    });
    if (!response.ok) {
      return { ok: false, error: `Linear API 返回 HTTP ${response.status}；检查 key、网络或权限。` };
    }
    const payload = await readJson(response);
    if (!payload?.data?.projects || Array.isArray(payload.errors)) {
      return { ok: false, error: 'Linear 拒绝了凭据或 GraphQL 查询；检查 key 权限。' };
    }
    const nodes = Array.isArray(payload.data.projects?.nodes) ? payload.data.projects.nodes : [];
    const projects = nodes.flatMap((node: Record<string, unknown>) => (
      typeof node.id === 'string' && typeof node.name === 'string' && typeof node.slugId === 'string'
        ? [{ id: node.id, name: node.name, slug: node.slugId }]
        : []
    ));
    return { ok: true, projects };
  } catch (error) {
    return { ok: false, error: safeFailure('Linear', error).detail };
  }
}

async function probeLinear(
  input: ConfigurationDoctorInput,
  options: ConfigurationDoctorOptions,
): Promise<DoctorResult> {
  if (!input.linearApiKey) {
    return { label: 'Linear', status: 'fail', detail: '未配置 API key。' };
  }
  const discovered = await discoverLinearProjects(input.linearApiKey, {
    ...options,
    linearEndpoint: input.linearEndpoint,
  });
  if (!discovered.ok) {
    return { label: 'Linear', status: 'fail', detail: discovered.error };
  }
  const project = discovered.projects.find((candidate) => candidate.slug === input.linearProjectSlug);
  return project
    ? { label: 'Linear', status: 'pass', detail: `凭据有效，项目 ${project.name} (${project.slug}) 可访问。` }
    : {
        label: 'Linear',
        status: 'fail',
        detail: `凭据有效，但找不到 project slug=${input.linearProjectSlug || '(未配置)'}；重新运行向导选择项目。`,
      };
}

export async function probeGitHubRepository(
  input: GitHubRepositoryProbeInput,
  options: ConfigurationDoctorOptions = {},
): Promise<DoctorResult> {
  if (!input.token || !input.owner || !input.repo) {
    return { label: 'GitHub', status: 'fail', detail: '缺少 token 或 owner/repo 路由。' };
  }
  const { fetchImpl, signal } = fetchOptions(options);
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
      {
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'SymHarix-Setup-Doctor',
        },
        signal,
      },
    );
    if (!response.ok) {
      const reason = response.status === 401
        ? 'token 无效、已过期或复制不完整。'
        : response.status === 403
          ? 'token 被拒绝；检查仓库权限、SSO 或组织审批。'
          : response.status === 404
            ? '仓库不存在，或 token 没有选择/访问该仓库。'
            : '检查 token、仓库选择和网络状态。';
      return {
        label: 'GitHub',
        status: 'fail',
        detail: `GitHub 返回 HTTP ${response.status}；${reason}`,
      };
    }
    const payload = await readJson(response);
    const push = payload?.permissions?.push;
    return push === false
      ? {
          label: 'GitHub',
          status: 'fail',
          detail: `可以读取 ${input.owner}/${input.repo}，但 token 没有 push 权限；Contents 必须为 Read and write。`,
        }
      : {
          label: 'GitHub',
          status: 'pass',
          detail: `仓库 ${input.owner}/${input.repo} 可访问${push === true ? '且可写' : '；API 未返回权限摘要，请在首个任务前确认 Contents/PR/Issues 可写'}。`,
        };
  } catch (error) {
    return safeFailure('GitHub', error);
  }
}

async function probeGitHub(
  input: ConfigurationDoctorInput,
  options: ConfigurationDoctorOptions,
): Promise<DoctorResult> {
  return probeGitHubRepository({
    token: input.githubToken,
    owner: input.githubOwner,
    repo: input.githubRepo,
  }, options);
}

function joinApiPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function probeModel(
  input: ConfigurationDoctorInput,
  options: ConfigurationDoctorOptions,
): Promise<DoctorResult> {
  if (input.usesOpenCodeAuth) {
    return {
      label: '模型凭据',
      status: 'skip',
      detail: '使用 OpenCode auth；运行 bun run runtime:auth -- list 查看提供方，再运行 bun run runtime:smoke 做真实模型调用。',
    };
  }
  if (!input.runtimeProvider || !input.runtimeApiKey) {
    return { label: '模型凭据', status: 'fail', detail: '缺少 provider 或对应 API key。' };
  }

  let url: string;
  let headers: Record<string, string>;
  switch (input.runtimeProvider) {
    case 'anthropic':
      url = joinApiPath(input.runtimeBaseUrl || 'https://api.anthropic.com', 'v1/models');
      headers = { 'x-api-key': input.runtimeApiKey, 'anthropic-version': '2023-06-01' };
      break;
    case 'openai':
      url = joinApiPath(input.runtimeBaseUrl || 'https://api.openai.com/v1', 'models');
      headers = { Authorization: `Bearer ${input.runtimeApiKey}` };
      break;
    case 'google':
      url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
      headers = { 'x-goog-api-key': input.runtimeApiKey };
      break;
    case 'deepseek':
      url = 'https://api.deepseek.com/models';
      headers = { Authorization: `Bearer ${input.runtimeApiKey}` };
      break;
    case 'openrouter':
      url = 'https://openrouter.ai/api/v1/auth/key';
      headers = { Authorization: `Bearer ${input.runtimeApiKey}` };
      break;
    case 'alibaba-cn':
      url = joinApiPath(
        input.runtimeBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'models',
      );
      headers = { Authorization: `Bearer ${input.runtimeApiKey}` };
      break;
    default:
      if (!input.runtimeBaseUrl) {
        return { label: '模型凭据', status: 'fail', detail: '自定义 provider 缺少 Base URL。' };
      }
      url = joinApiPath(input.runtimeBaseUrl, 'models');
      headers = { Authorization: `Bearer ${input.runtimeApiKey}` };
  }

  const { fetchImpl, signal } = fetchOptions(options);
  try {
    const response = await fetchImpl(url, { headers, signal });
    return response.ok
      ? { label: '模型凭据', status: 'pass', detail: `${input.runtimeProvider} 凭据端点验证通过；未产生模型调用费用。` }
      : {
          label: '模型凭据',
          status: 'fail',
          detail: `${input.runtimeProvider} 返回 HTTP ${response.status}；检查 key、billing、区域或 Base URL。`,
        };
  } catch (error) {
    return safeFailure('模型凭据', error);
  }
}

async function probeTelegram(
  input: ConfigurationDoctorInput,
  options: ConfigurationDoctorOptions,
): Promise<DoctorResult> {
  if (!input.telegramToken) {
    return { label: 'Telegram', status: 'skip', detail: '未启用。' };
  }
  const { fetchImpl, signal } = fetchOptions(options);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${input.telegramToken}/getMe`, { signal });
    const payload = await readJson(response);
    if (!response.ok || payload?.ok !== true) {
      return { label: 'Telegram', status: 'fail', detail: `Telegram 返回 HTTP ${response.status}；请从 @BotFather 重新复制或轮换 token。` };
    }

    const infoResponse = await fetchImpl(
      `https://api.telegram.org/bot${input.telegramToken}/getWebhookInfo`,
      { signal },
    );
    const infoPayload = await readJson(infoResponse);
    if (!infoResponse.ok || infoPayload?.ok !== true) {
      return {
        label: 'Telegram',
        status: 'fail',
        detail: `Bot token 有效，但 getWebhookInfo 返回 HTTP ${infoResponse.status}。`,
      };
    }

    const username = payload.result?.username ? `@${payload.result.username}` : 'Telegram Bot';
    const webhook = infoPayload.result ?? {};
    const webhookUrl = typeof webhook.url === 'string' ? webhook.url.trim() : '';
    const publicBaseUrl = input.telegramPublicBaseUrl?.trim().replace(/\/+$/, '') || '';
    const fixedPublicBaseUrl = publicBaseUrl && !/\.trycloudflare\.com$/i.test(publicBaseUrl)
      ? publicBaseUrl
      : '';
    const expectedWebhookUrl = fixedPublicBaseUrl
      ? `${fixedPublicBaseUrl}/api/v1/bots/telegram/webhook`
      : '';
    if (expectedWebhookUrl && webhookUrl !== expectedWebhookUrl) {
      return {
        label: 'Telegram',
        status: 'fail',
        detail: `${username} token 有效，但 webhook=${webhookUrl || '(none)'}，预期为 ${expectedWebhookUrl}；重启 symharix start telegram 触发修复。`,
      };
    }
    if (!webhookUrl) {
      return {
        label: 'Telegram',
        status: 'pass',
        detail: `${username} token 有效；当前未注册 webhook，启动 symharix start telegram 后会自动注册。`,
      };
    }

    const pending = Number(webhook.pending_update_count ?? 0);
    const lastErrorMessage = typeof webhook.last_error_message === 'string'
      ? webhook.last_error_message.trim()
      : '';
    const lastErrorSeconds = Number(webhook.last_error_date ?? 0);
    const recentError = Boolean(
      lastErrorMessage
      && (!Number.isFinite(lastErrorSeconds)
        || lastErrorSeconds <= 0
        || Date.now() - lastErrorSeconds * 1000 <= 15 * 60 * 1000),
    );
    if (recentError || (Number.isFinite(pending) && pending >= 5)) {
      return {
        label: 'Telegram',
        status: 'fail',
        detail: `${username} webhook 已注册但状态异常：pending=${Number.isFinite(pending) ? pending : 'unknown'}${lastErrorMessage ? `；${lastErrorMessage}` : ''}。`,
      };
    }
    return {
      label: 'Telegram',
      status: 'pass',
      detail: `${username} webhook 健康；pending=${Number.isFinite(pending) ? pending : 0}；url=${webhookUrl}。`,
    };
  } catch (error) {
    return safeFailure('Telegram', error);
  }
}

async function probeFeishu(
  input: ConfigurationDoctorInput,
  options: ConfigurationDoctorOptions,
): Promise<DoctorResult> {
  if (!input.feishuAppId && !input.feishuAppSecret) {
    return { label: '飞书', status: 'skip', detail: '未启用。' };
  }
  if (!input.feishuAppId || !input.feishuAppSecret) {
    return { label: '飞书', status: 'fail', detail: 'App ID 和 App Secret 必须同时配置。' };
  }
  const { fetchImpl, signal } = fetchOptions(options);
  try {
    const response = await fetchImpl(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: input.feishuAppId, app_secret: input.feishuAppSecret }),
        signal,
      },
    );
    const payload = await readJson(response);
    return response.ok && payload?.code === 0 && typeof payload.tenant_access_token === 'string'
      ? { label: '飞书', status: 'pass', detail: 'App ID/App Secret 验证通过；未发送消息或修改应用。' }
      : { label: '飞书', status: 'fail', detail: `飞书返回 HTTP ${response.status} / code ${String(payload?.code ?? 'unknown')}；检查应用凭据。` };
  } catch (error) {
    return safeFailure('飞书', error);
  }
}

export async function runConfigurationDoctor(
  input: ConfigurationDoctorInput,
  options: ConfigurationDoctorOptions = {},
): Promise<DoctorResult[]> {
  return Promise.all([
    probeLinear(input, options),
    probeGitHub(input, options),
    probeModel(input, options),
    probeTelegram(input, options),
    probeFeishu(input, options),
  ]);
}
