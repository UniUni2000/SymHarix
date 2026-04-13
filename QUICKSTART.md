# Symphony 项目快速开始

## 项目结构

```
symharix/
├── claude-code/        # 集成的本地 Claude Code CLI 源码
├── src/
│   ├── web-dashboard/  # React Web 界面
│   ├── server/         # Hono HTTP 服务器
│   ├── telegram/       # Telegram Bot
│   ├── orchestrator/   # 任务编排器
│   └── ...
├── scripts/            # 部署脚本
├── docs/               # 文档
└── package.json
```

## 运行

### Claude Code

```bash
# 运行集成的 Claude Code
bun run claude

# 或使用 bin 直接运行
./claude-code/bin/claude-haha
```

### Symphony

```bash
# 安装依赖
bun install

# 运行 Symphony
bun run start

# 开发模式
bun run dev
```

### Web Dashboard

```bash
# 构建
bun run build:dashboard

# 开发服务器 (在 src/web-dashboard 目录)
cd src/web-dashboard && bun dev
```

## 配置

复制环境变量文件并配置：

```bash
cp .env.example .env
```

需要配置：
- `ANTHROPIC_API_KEY` - Anthropic API 密钥
- `SYMPHONY_TRACKER_API_KEY` - Linear API 密钥（如果使用 Linear）
- `TELEGRAM_BOT_TOKEN` - Telegram Bot 令牌（可选）

## 部署

```bash
# 准备部署
bun run deploy:prepare

# 安装 systemd 服务
bun run deploy:service
```

详见 [docs/deployment.md](docs/deployment.md)
