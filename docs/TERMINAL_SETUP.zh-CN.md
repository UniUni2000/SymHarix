# SymHarix 终端配置与验证手册

下载发行包后使用以下六条指令，不要求手工编辑 `.env` 或 `WORKFLOW.md`：

```bash
symharix guide
symharix configure
symharix check
symharix doctor
symharix smoke
symharix start telegram # 或 symharix start feishu
```

## 配置完成后如何修改

直接运行 `symharix config`，会显示数字配置管理菜单：

```text
1. Linear 与 GitHub 仓库路由
2. 代码模型与聊天理解模型
3. Telegram
4. 飞书
5. 预算、模型价格与单轮上限
6. Runtime 安全密钥与会话时间
7. 查看掩码配置状态
8. 联网只读验证凭据
9. 重新运行完整向导
0. 退出
```

也可跳过主菜单，直接修改一类配置：

```bash
symharix config models
symharix config telegram
symharix config feishu
symharix config connections
symharix config budget
symharix config security
```

每次只暂存并写入所选分类。输入错误时可重试或返回，不会破坏其他已经可用的配置。Telegram/飞书可以从分类菜单明确禁用并清除对应本地凭据；预算提供保守、标准、宽松三个数字选项以及逐项自定义；安全菜单可以只补缺、单独轮换 viewer/operator/session 密钥或修改会话 TTL。轮换密钥后需要重启 SymHarix。

在源码仓库开发时，等价命令为：

```bash
bun run configure:guide   # 查看所有 key/token 的获取步骤，不修改文件
bun run configure:secure  # 只补齐本地 Runtime 安全密钥
bun run configure         # 交互式写入外部凭据和仓库路由
bun run configure:check   # 离线检查字段、格式和路由
bun run configure:doctor  # 只读联网验证外部凭据
bun run runtime:smoke     # 显式执行一次真实、低成本模型调用
```

## 已有 key/token 时如何处理

向导不会打印完整凭据。检测到已有值时，会先显示首尾掩码，再要求明确选择：

```text
GitHub token 当前已配置：git••••789

如何处理当前 GitHub token？
  1. 继续使用（不改动）
  2. 覆盖当前 key/token
选择:
```

- 选择 `1`：继续使用当前值；向导不会要求重新粘贴，也不会改写 `.env` 中的该配置项。
- 选择 `2`：进入不回显的新值输入；新值通过格式预检后才会写入。
- 尚未配置时：直接进入不回显输入，不显示无意义的保留选项。

这一行为统一覆盖 Linear、GitHub、代码模型、聊天模型、Telegram token 和飞书 App Secret。本地自动生成的 Runtime 安全密钥由 `configure:secure` 负责补缺，已有值始终不会自动轮换。

## 数字选择、自由输入与回退

能枚举的配置都优先显示为数字菜单，包括是否启用、Linear 项目、代码/聊天模型、提供方、Base URL 和聊天入口。每个模型/项目菜单的最后一项保留“自定义输入”，因此既可以一键选推荐值，也不会限制私有模型或新模型 ID。

输入格式不正确时，向导不会直接显示 `error / 配置未完成` 后退出：

```text
输入未通过：GitHub repository 必须写成 owner/repo

如何处理这个输入？
  1. 重新输入当前项
  2. 返回本阶段开头重新选择
```

非输入类的阶段异常也可以选择重新开始当前阶段、返回上一阶段，或取消配置。取消和回退都会恢复阶段开始前的暂存值；只有 Linear、GitHub、模型和聊天入口全部通过最终格式预检后，才会一次性写入 `.env` 与 `WORKFLOW.md`。

## 1. Linear

1. 打开 Linear 的 `Settings → Account → Security & Access`。
2. 在 `Personal API keys` 新建 `SymHarix` key。restricted key 至少需要读取项目，以及读写 issue、comment 和 state。
3. 复制只显示一次的 key。运行 `bun run configure` 后，SymHarix 会调用只读 GraphQL 查询列出可见项目，直接按编号选择；菜单末尾仍可自定义 project slug。
4. 官方说明：<https://linear.app/docs/api-and-webhooks>。

## 2. GitHub

1. 打开 <https://github.com/settings/personal-access-tokens/new> 创建 fine-grained token。
2. `Resource owner` 选择仓库所属个人或组织；`Repository access` 只选择需要操作的仓库。
3. Repository permissions：`Contents = Read and write`、`Pull requests = Read and write`、`Issues = Read and write`；Metadata 保持自动只读。
4. 组织若要求 SSO 或管理员审批，创建后还要完成授权。建议设置过期日期并使用 SymHarix 专用 token。

输入 token 后，向导会在进入模型配置前立即验证目标仓库是否可见，并在 GitHub 返回权限摘要时确认 push 权限；它不会 push、建 PR 或创建 issue。`github_pat_`、`ghp_` 和 GitHub CLI 常见的 `gho_` 都会被识别。

验证失败时不会静默跳到下一步，而是要求明确选择：重新输入、使用同一 token 重试、离线保留为“未验证”，或取消且不写入。`configure:doctor` 可在配置完成后重复执行同一只读检查。

## 3. 模型与 OpenCode

只需选择一种提供方。最省配置的是复用 OpenCode 登录：

```bash
bun run runtime:install
bun run runtime:auth -- login
bun run runtime:auth -- list
bun run runtime:models -- deepseek # provider 可替换
```

`runtime:auth -- list` 只显示已登录提供方，不显示 key。使用 API key 时，向导会针对所选提供方打印以下精确入口：

| 提供方 | 创建 key | 写入变量 |
| --- | --- | --- |
| Anthropic | <https://console.anthropic.com/settings/keys> | `ANTHROPIC_API_KEY` |
| OpenAI | <https://platform.openai.com/api-keys> | `OPENAI_API_KEY` |
| Google Gemini | <https://aistudio.google.com/app/apikey> | `GOOGLE_GENERATIVE_AI_API_KEY` |
| DeepSeek | <https://platform.deepseek.com/api_keys> | `DEEPSEEK_API_KEY` |
| OpenRouter | <https://openrouter.ai/settings/keys> | `OPENROUTER_API_KEY` |
| 阿里云百炼 | <https://bailian.console.aliyun.com/?apiKey=1#/api-key> | `DASHSCOPE_API_KEY` |

代码模型菜单提供推荐 ID 与“自定义 provider/model”；聊天模型菜单同样提供推荐 ID 与“自定义模型名称”。可先运行 `bun run runtime:models -- <provider>` 查看锁定 OpenCode 版本实际识别的 ID。自定义值如果格式错误，可以当场重输或返回模型阶段开头，不会跳过到下一步。

首次安装 OpenCode 时会实时显示下载百分比、已下载/总大小、平均速度和耗时。默认连续 30 秒没有收到新数据，或总下载时间超过 5 分钟，会终止本次连接并提供数字选择：

```text
1. 重试下载
2. 暂时跳过（配置会保留，稍后运行 symharix runtime install）
```

超时或选择暂时跳过时，已经下载并写入磁盘的部分会保留在用户运行时缓存中。选择重试或以后再次执行安装会使用 HTTP Range 从断点续传；校验和不匹配时才会丢弃损坏的部分并重新下载。

在 CI 或网络条件特殊的环境可以调整 `SYMHARIX_OPENCODE_DOWNLOAD_STALL_TIMEOUT_MS` 和 `SYMHARIX_OPENCODE_DOWNLOAD_TIMEOUT_MS`；单位都是毫秒。不建议把超时设为无限，避免配置向导看似永久卡住。

### Telegram/飞书的聊天理解模型

聊天理解模型用于区分问候、普通问答、计划沟通和需要进入 Agent 工作流的命令。它可以直接选择 DeepSeek，不需要把 DeepSeek 当作陌生的“自定义兼容服务”：

- 菜单选择 `DeepSeek`；
- 默认模型为 `deepseek-v4-flash`；
- Base URL 自动使用 `https://api.deepseek.com`；
- 如果前面已配置 DeepSeek 代码运行时，默认直接复用同一个 `DEEPSEEK_API_KEY`，不再要求粘贴；
- 只有其他兼容 OpenAI 协议的第三方服务，才选择“其他 OpenAI 兼容服务”。

`configure:doctor` 只验证 key/模型列表端点，不发起生成请求。完整调用链必须由操作者显式运行：

```bash
bun run runtime:smoke
```

该命令会请求模型严格回复一个短字符串，因此会产生极少量 token 费用。

## 4. Telegram

1. 打开 Telegram 官方 [@BotFather](https://t.me/BotFather)，发送 `/newbot`。
2. 输入显示名称和以 `bot` 结尾的 username，复制 BotFather 返回的 `数字:长字符串` token。
3. operator ID 可以先留空。完成配置后运行 `bun run start:telegram`，向机器人发送 `/new 测试`。
4. fail-closed 只读回复会显示 `Detected user id`。把该数字重新填进向导；多人使用英文逗号分隔。
5. token 泄漏时使用 BotFather `/revoke`，不要只删除本地 `.env`。

`configure:doctor` 使用 Telegram `getMe` 验证 token，并显示 bot username；不会发送消息或修改 webhook。

## 5. 飞书

1. 在<https://open.feishu.cn/app>创建“企业自建应用”，添加机器人能力。
2. 在 `基础信息 → 凭证与基础信息` 复制 `App ID` 和 `App Secret`。
3. 权限管理至少开通：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`。
4. 先运行 `bun run start:feishu` 建立连接，再在 `事件与回调` 选择“使用长连接接收事件”，订阅 `im.message.receive_v1`；需要卡片交互时配置 `card.action.trigger`。
5. 创建并发布应用版本。operator `open_id` 可先留空；启动机器人后发送 `/whoami`（也支持 `/id` 或“我的 detected user id 是什么”），从只读回复复制 `Detected user id: ou_...`，再运行向导填回。明确的写命令（例如“创建一个测试任务”）在只读模式下也会显示该 ID。

`configure:doctor` 只使用 App ID/Secret 获取临时 tenant token 来验证凭据，不发送消息、不改权限。

## 6. 格式预检会拦截什么

`bun run configure:check` 和交互向导会在联网前识别：

- key 只复制了一部分、包含空格或换行；
- GitHub/Linear/模型 key 的常见前缀异常（未来格式只警告、不误杀）；
- Telegram token 不是 `数字:长字符串`，或把 `@username` 当 numeric operator ID；
- 飞书 App ID 不是 `cli_...`，或 operator 不是 `ou_...`；
- 模型不是 `provider/model`；
- 公网 Base URL 不是 HTTPS、URL 内嵌密码；
- Runtime 密钥长度不足、viewer/operator 相同、session secret 与访问 token 相同；
- Runtime session TTL 不是 1–1440 分钟整数；
- token/step/override 限制不是正整数，或美元/价格配置不是大于 0 的数字；
- `SYMHARIX_OPENCODE_PROVIDER` 与 `provider/model` 前缀不一致；
- 只填写 input/output 其中一种价格，导致美元护栏实际上未启用（警告）。

## 7. 推荐验收顺序

```bash
bun run configure:check
bun run configure:doctor
bun run runtime:auth -- list  # 使用 OpenCode auth 时
bun run runtime:smoke
bun run release:check
```

前两步不会产生外部写操作或模型费用。`runtime:smoke` 只验证模型链路；`release:check` 验证依赖安全、类型、全部隔离测试、构建、发布包和锁定 OpenCode runtime。
