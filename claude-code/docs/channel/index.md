# Claude Code Channel 系统文档

> 通过 IM 平台远程控制 Claude Code Agent 的完整技术解析

---

## 文档目录

### [01-channel-system.md](./01-channel-system.md) — Channel 系统架构解析

从源码视角深度剖析 Claude Code Channel 系统的设计与实现，涵盖：

- **什么是 Channel**：IM 集成的核心概念、MCP 协议基础
- **整体架构**：消息流转全链路、组件关系
- **消息协议**：入站通知、XML 封装、出站工具调用
- **六层访问控制**：能力声明 → 运行时开关 → OAuth 认证 → 组织策略 → 会话白名单 → 插件审批
- **权限中继系统**：远程审批工具执行、5 字母请求 ID、多源竞争
- **插件架构**：Channel 插件清单声明、用户配置流、作用域命名
- **UI 组件**：终端消息渲染、状态通知、开发者警告对话框
- **安全设计**：防 XML 注入、marketplace 验证、信任边界分析

**适合人群**：想了解 AI Agent IM 集成架构的开发者、架构师、插件作者

---

## 配图说明

所有配图采用深色背景（#1a1a2e）+ Anthropic 品牌橙铜色（#D97757）风格。

| 图片 | 说明 | 所属文档 |
|------|------|----------|
| `01-channel-overview.png` | Channel 系统架构总览 — 组件关系全景 | 架构解析 |
| `02-message-flow.png` | 消息流转全链路 — IM → Agent → IM | 架构解析 |
| `03-access-control.png` | 六层访问控制 — 层层递进的安全门 | 架构解析 |
| `04-permission-relay.png` | 权限中继系统 — 远程审批流程 | 架构解析 |

---

## 快速开始

### 用户

1. 阅读 [Channel 系统架构解析](./01-channel-system.md)
2. 了解如何通过 `--channels` 启动 IM 集成
3. 理解不同平台（Telegram、Feishu、Discord）的接入方式

### 插件开发者

1. 阅读架构解析中的 [插件架构](./01-channel-system.md#七插件-channel-架构) 章节
2. 了解 `plugin.json` 中 Channel 声明格式
3. 实现 MCP Server 的 `notifications/claude/channel` 协议
4. 查看源码位置：
   - `src/services/mcp/channelNotification.ts` — 核心门控与消息封装
   - `src/services/mcp/channelPermissions.ts` — 权限中继系统
   - `src/services/mcp/channelAllowlist.ts` — 白名单管理
   - `src/utils/plugins/mcpPluginIntegration.ts` — 插件 MCP 集成
   - `src/utils/plugins/schemas.ts` — 插件清单 Channel 声明 Schema

---

## 核心概念速查

| 概念 | 说明 |
|------|------|
| **Channel** | 一个声明了 `claude/channel` 能力的 MCP Server，可推送 IM 消息到 Agent |
| **Channel Entry** | `--channels` 参数解析后的条目，分 plugin 和 server 两种 |
| **Channel Gate** | 六层访问控制门，决定是否注册通知处理器 |
| **Permission Relay** | 将工具执行审批提示转发到 IM 平台的机制 |
| **Channel Plugin** | 在 `plugin.json` 中声明 `channels` 字段的插件 |
| **Scoped Name** | 插件服务器的作用域名称，格式 `plugin:{pluginName}:{serverName}` |
| **Short Request ID** | 5 字母权限请求标识符，基于 FNV-1a 哈希生成 |
| **Channel Tag** | `<channel>` XML 标签，封装来自 IM 的消息内容和元数据 |
| **Dev Channels** | 通过 `--dangerously-load-development-channels` 加载的本地开发频道 |
| **tengu_harbor** | GrowthBook 运行时特性开关，控制 Channel 功能总开关 |

---

## 相关资源

- [Claude Code Haha 主页](/)
- [Agent 框架解析](/agent/03-agent-framework)
- [Skills 系统文档](/skills/01-usage-guide)
- [GitHub Issues](https://github.com/NanmiCoder/cc-haha/issues)
