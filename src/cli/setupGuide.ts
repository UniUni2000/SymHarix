export type SetupGuideTopic =
  | 'linear'
  | 'github'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'alibaba-cn'
  | 'openai-compatible'
  | 'existing-auth'
  | 'telegram'
  | 'feishu';

const TOPIC_GUIDES: Record<SetupGuideTopic, string> = {
  linear: `Linear API key 和项目
  1. 打开 Linear → Settings → Account → Security & Access。
  2. 在 Personal API keys 新建名为 SymHarix 的 key；若使用 restricted key，至少允许读取项目，并读写 issue/comment/state。
  3. key 通常只完整显示一次，立即复制；不要粘贴到聊天、截图或 Git。
  4. 向导拿到 key 后会读取可见项目并让你编号选择，不需要手抄 project slug。
  官方说明: https://linear.app/docs/api-and-webhooks`,

  github: `GitHub fine-grained token
  1. 打开 Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。
  2. Resource owner 选择目标仓库所属个人或组织；Repository access 只选择 SymHarix 要操作的仓库。
  3. Repository permissions 设置：Contents=Read and write、Pull requests=Read and write、Issues=Read and write；Metadata 保持自动 Read-only。
  4. 如果组织要求 SSO/管理员审批，生成后还要完成授权；建议设置过期时间并为 SymHarix 单独建 token。
  5. 向导会在进入模型配置前立即用只读请求验证 token、目标仓库和 push 权限；失败时必须明确选择重输、重试、离线保留或取消。
  6. 支持 github_pat_ / ghp_，也支持 GitHub CLI 常见的 gho_ OAuth token；完整 token 始终不回显。
  创建入口: https://github.com/settings/personal-access-tokens/new
  官方说明: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens`,

  anthropic: `Anthropic API key
  1. 登录 Claude Console，先为 API 账户配置 billing/credits。
  2. 进入 Settings → API keys → Create Key，创建 SymHarix 专用 key 并立即复制。
  3. 这是 API Console key，不是 claude.ai 聊天订阅；写入变量 ANTHROPIC_API_KEY。
  创建入口: https://console.anthropic.com/settings/keys
  官方说明: https://platform.claude.com/docs/en/manage-claude/authentication`,

  openai: `OpenAI API key
  1. 登录 OpenAI Platform，在项目的 API keys 页面创建 project key；API 计费与 ChatGPT 订阅分开。
  2. 给项目配置 billing/usage limits，创建 SymHarix 专用 key 并立即复制。
  3. 写入变量 OPENAI_API_KEY，不要把 key 放进前端代码或仓库。
  创建入口: https://platform.openai.com/api-keys
  官方说明: https://platform.openai.com/docs/api-reference/authentication`,

  google: `Google Gemini API key
  1. 打开 Google AI Studio → Dashboard → API Keys；新用户接受条款后通常会自动获得项目。
  2. 选择现有 Cloud project 或创建/导入项目，再创建只用于 Gemini API 的 key。
  3. 写入 GOOGLE_GENERATIVE_AI_API_KEY；建议限制为 Gemini API，并在需要时启用 billing。
  创建入口: https://aistudio.google.com/app/apikey
  官方说明: https://ai.google.dev/gemini-api/docs/api-key`,

  deepseek: `DeepSeek API key
  1. 登录 DeepSeek 开放平台，先在余额/充值页面准备 API 额度。
  2. 在 API keys 页面创建 SymHarix 专用 key 并立即复制。
  3. 写入 DEEPSEEK_API_KEY；聊天网页账号本身不能替代 API key。
  4. 代码执行默认使用 deepseek-v4-pro；聊天理解默认使用更轻量的 deepseek-v4-flash 和 https://api.deepseek.com。
  5. 若前面已配置 DeepSeek 代码运行时，聊天模型可以直接复用同一个 key，无需再次粘贴。
  创建入口: https://platform.deepseek.com/api_keys
  官方说明: https://api-docs.deepseek.com/`,

  openrouter: `OpenRouter API key
  1. 登录 OpenRouter → Settings → Keys → Create Key。
  2. 建议设置该 key 的 USD credit limit/到期时间，再复制只显示一次的 key。
  3. 写入 OPENROUTER_API_KEY；选择模型时使用 openrouter/厂商/模型 格式。
  创建入口: https://openrouter.ai/settings/keys
  官方说明: https://openrouter.ai/docs/quickstart`,

  'alibaba-cn': `阿里云百炼 API key
  1. 打开百炼控制台，确认所选地域（国内通常为华北 2/北京）。
  2. 进入 API Key 页面 → 创建 API Key，并记下弹窗里的 API Host/地域。
  3. 写入 DASHSCOPE_API_KEY；不同地域的 key 与 endpoint 不要混用。
  创建入口: https://bailian.console.aliyun.com/?apiKey=1#/api-key
  官方说明: https://help.aliyun.com/zh/model-studio/get-api-key/`,

  'openai-compatible': `自定义 OpenAI-compatible 服务
  1. 从服务提供方获取 API key、Base URL 和精确 model id；Base URL 通常以 /v1 结尾。
  2. 向导分别写入 SYMHARIX_OPENCODE_API_KEY 与 SYMHARIX_OPENCODE_BASE_URL。
  3. 先确认该服务实现 GET /models 与聊天/响应接口；私有证书或代理需由系统信任。`,

  'existing-auth': `复用 OpenCode 已保存凭据
  1. 安装锁定版本：bun run runtime:install
  2. 交互登录提供方：bun run runtime:auth -- login
  3. 只查看已登录提供方（不会显示 key）：bun run runtime:auth -- list
  4. 查看模型 ID：bun run runtime:models -- <provider>
  5. 做一次会产生极少量模型费用的真实调用：bun run runtime:smoke`,

  telegram: `Telegram Bot token 与 operator ID
  1. 在 Telegram 打开官方 @BotFather，发送 /newbot，依次填写机器人名称和以 bot 结尾的 username。
  2. BotFather 返回形如 123456:ABC... 的 token；立即复制。泄漏时在 BotFather 用 /revoke 轮换。
  3. operator ID 可以先留空。配置完成后运行 bun run start:telegram，向机器人发送 /new 测试；只读拒绝消息会显示 Detected user id。
  4. 把该数字重新填入向导；多人用英文逗号分隔。不要把群 chat_id 当作用户 operator ID。
  官方入口: https://t.me/BotFather
  官方教程: https://core.telegram.org/bots/tutorial`,

  feishu: `飞书 App ID、App Secret 与 operator open_id
  1. 在飞书开放平台创建“企业自建应用”，在 应用能力 → 添加应用能力 中添加机器人。
  2. 在 基础信息 → 凭证与基础信息 复制 App ID 和 App Secret。
  3. 权限管理至少开通：im:message.p2p_msg:readonly、im:message.group_at_msg:readonly、im:message:send_as_bot。
  4. 先运行 bun run start:feishu 建立连接，再在 事件与回调 中选择“使用长连接接收事件”，订阅 im.message.receive_v1；需要卡片交互时再配置 card.action.trigger。
  5. 创建并发布应用版本。operator open_id 可先留空；向机器人发送 /whoami 后，从只读回复中的 Detected user id 复制 ou_...，再运行向导填回。
  开发者后台: https://open.feishu.cn/app
  官方配置: https://open.feishu.cn/document/develop-an-echo-bot/faq?lang=zh-CN`,
};

export function getSetupGuideTopic(topic: SetupGuideTopic): string {
  return TOPIC_GUIDES[topic];
}

export function printSetupGuideTopic(
  topic: SetupGuideTopic,
  write: (message: string) => void = console.log,
): void {
  write(`\n${TOPIC_GUIDES[topic]}\n`);
}

export function renderSetupGuide(): string {
  return `SymHarix 终端配置手册

推荐命令
  下载发行包：
  symharix guide           查看本手册，不修改任何文件
  symharix configure       交互配置 Linear、GitHub、模型与聊天入口
  symharix check           离线检查字段、路由和安全配置
  symharix doctor          联网只读验证已配置凭据
  symharix smoke           显式执行一次低成本真实模型调用

  源码仓库中的等价开发命令：
  bun run configure:guide   查看本手册，不修改任何文件
  bun run configure:secure  只补齐本地 Runtime 安全密钥，不询问外部账号
  bun run configure         交互配置 Linear、GitHub、模型与聊天入口
  bun run configure:check   离线检查字段、路由和安全配置，不访问外网
  bun run configure:doctor  联网验证已配置凭据；只显示状态，不显示密钥
  bun run runtime:smoke     真实调用一次当前模型，产生极少量模型费用

最短路径
  1. 下载版先运行 symharix guide；源码版运行 bun run configure:guide。
  2. 下载版运行 symharix configure；源码版运行 bun run configure。能枚举的项目使用数字选择，每组最后都保留“自定义输入”。
  3. 密钥输入不回显；已有值会半隐藏展示并要求明确选择保留或覆盖。
  4. 输入格式错误时选择“重新输入当前项”或“返回本阶段开头”；阶段异常可重试、返回上一阶段或取消且不写入本轮输入。
  5. 运行 symharix doctor（或 bun run configure:doctor），确认 Linear/GitHub/模型/Bot 凭据可用。
  6. 运行 symharix smoke（或 bun run runtime:smoke），确认 OpenCode 到模型的真实调用链。
  7. 运行 symharix start telegram / symharix start feishu；源码版使用对应 bun run start:* 命令。

${TOPIC_GUIDES.linear}

${TOPIC_GUIDES.github}

模型提供方（只需选择一种）

${TOPIC_GUIDES['existing-auth']}

${TOPIC_GUIDES.anthropic}

${TOPIC_GUIDES.openai}

${TOPIC_GUIDES.google}

${TOPIC_GUIDES.deepseek}

${TOPIC_GUIDES.openrouter}

${TOPIC_GUIDES['alibaba-cn']}

聊天入口（可任选、同时配置或暂时不配）

${TOPIC_GUIDES.telegram}

${TOPIC_GUIDES.feishu}

安全规则
  - 模型、项目、入口、是否启用等可枚举配置优先用数字选择；模型列表最后始终提供自定义 model id。
  - 本地输入错误不会直接终止向导；最终格式预检通过前，本轮输入不会写入 .env 或 WORKFLOW.md。
  - 所有外部 key 只写入 .env；该文件权限会收紧为 0600，且不得提交 Git。
  - 已配置的 key/token 只显示首尾掩码；选择“继续使用”时不会读取新值，也不会改写原配置项。
  - 只有明确选择“覆盖当前 key/token”后，向导才会进入不回显的新值输入并重新做格式校验。
  - Runtime viewer/operator/session secret 由 SymHarix 本地随机生成，不需要去第三方平台申请。
  - configure:doctor 不执行 GitHub 写入、Linear 写入、Bot 发消息或模型计费调用。
  - 只有 runtime:smoke 会做一次真实模型请求；执行前终端会明确说明。
`;
}

export function printSetupGuide(write: (message: string) => void = console.log): void {
  write(renderSetupGuide());
}
