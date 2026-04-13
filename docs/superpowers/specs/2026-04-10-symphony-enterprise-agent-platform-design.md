# Symphony 企业级软件开发代理平台设计文档

**版本：** 1.0  
**日期：** 2026-04-10  
**作者：** AI Assistant  
**状态：** 待评审

---

## 目录

1. [概述](#1-概述)
2. [系统架构](#2-系统架构)
3. [核心模块设计](#3-核心模块设计)
4. [用户界面设计](#4-用户界面设计)
5. [安全与权限](#5-安全与权限)
6. [部署与运维](#6-部署与运维)
7. [MVP 功能清单](#7-mvp-功能清单)
8. [开发计划](#8-开发计划)

---

## 1. 概述

### 1.1 项目愿景

构建一个高度专业自动化的软件开发代理平台，结合：
- **OpenAI Symphony** 的企业级代码开发自动化流程
- **Claude Code** 的高度 harness 执行能力
- **优秀的可视化体验** —— Web Dashboard + Telegram 移动控制

让用户像"领导"一样把控大方向，实施细节由 Agent 迭代把控。

### 1.2 目标用户

- 有 VPS/云服务器的开发者或小型团队
- 希望通过自然语言或 Linear issue 驱动开发流程
- 需要随时随地通过手机或浏览器监控、控制开发进度

### 1.3 核心价值

| 价值点 | 说明 |
|--------|------|
| 自动化 | Linear issue → 自动 Agent 执行 → 完成代码 |
| 可视化 | Web Dashboard 实时展示执行进度、日志、结果 |
| 移动优先 | Telegram Bot + Web App，随时随地控制 |
| 可信赖 | 自动模式减少审批，但关键操作可追溯、可审计 |

### 1.4 设计原则

1. **全自动优先** —— 默认无需审批，减少用户打扰
2. **渐进式披露** —— 摘要视图默认，详情可按需展开
3. **网络自适应** —— 有公网用 Web Dashboard，无公网降级到纯消息
4. **状态可恢复** —— 任何异常中断后，重启可恢复进度

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户访问层                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐          │
│   │   浏览器     │     │  Telegram   │     │    CLI      │          │
│   │  Web App    │     │  Bot/WebApp │     │  symphony   │          │
│   └─────────────┘     └─────────────┘     └─────────────┘          │
│         │                    │                    │                 │
│         └────────────────────┼────────────────────┘                 │
│                              │                                      │
│                    ┌─────────▼─────────┐                           │
│                    │   HTTP API Server │                           │
│                    │     (Port 8080)   │                           │
│                    └─────────┬─────────┘                           │
│                              │                                      │
└──────────────────────────────┼──────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────┐
│                     Symphony Core 层                                 │
├──────────────────────────────┼──────────────────────────────────────┤
│                              │                                      │
│   ┌──────────────────────────▼──────────────────────────┐           │
│   │                   Orchestrator                      │           │
│   │   • Polling (Linear)    • Task Queue                │           │
│   │   • State Management    • Concurrency Control       │           │
│   └──────────────────────────┬──────────────────────────┘           │
│                              │                                      │
│         ┌────────────────────┼────────────────────┐                 │
│         │                    │                    │                 │
│         │                    │                    │                 │
│   ┌─────▼─────┐     ┌───────▼───────┐    ┌──────▼──────┐           │
│   │  Linear   │     │   Workspace   │    │   Claude    │           │
│   │  Client   │     │   Manager     │    │   Runtime   │           │
│   └───────────┘     └───────────────┘    └─────────────┘           │
│                                                                     │
│   ┌─────────────────┐     ┌─────────────────┐                      │
│   │  Telegram Bot   │     │  Event Bus      │                      │
│   │  (grammy)       │     │  (内部事件)     │                      │
│   └─────────────────┘     └─────────────────┘                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────┐
│                     数据持久化层                                     │
├──────────────────────────────┼──────────────────────────────────────┤
│                              │                                      │
│                   ┌──────────▼──────────┐                          │
│                   │    SQLite 数据库     │                          │
│                   │  (symphony.db)      │                          │
│                   └─────────────────────┘                          │
│                                                                     │
│   Tables: issues, tasks, workspaces, executions, events, config    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 网络架构

```
┌─────────────────────────────────────────────────────────────┐
│                    用户侧访问                                │
│                                                             │
│   浏览器 ──https://your-vps:8080──► Dashboard              │
│   Telegram ─────Bot API ────────► 通知/命令                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   VPS/云服务器                               │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              Symphony Service                        │   │
│   │                                                      │   │
│   │   ┌──────────────┐  ┌──────────────┐                │   │
│   │   │  Web Server  │  │  Core Service│                │   │
│   │   │  :8080       │  │  (后台运行)   │                │   │
│   │   └──────────────┘  └──────────────┘                │   │
│   │                                                      │   │
│   │   ┌──────────────┐  ┌──────────────┐                │   │
│   │   │   SQLite     │  │  Workspaces  │                │   │
│   │   │   symphony.db│  │  (Git)       │                │   │
│   │   └──────────────┘  └──────────────┘                │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   出站连接：                                                 │
│   • Linear API (GraphQL)                                    │
│   • Telegram Bot API                                        │
│   • Anthropic API (Claude)                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 数据流

**Issue 创建流程：**
```
Telegram 用户
     │
     ▼
发送问题描述 ──► Bot 解析 ──► 确认创建
     │
     ▼
Linear API 创建 Issue (带 auto-fix 标签)
     │
     ▼
Symphony 轮询检测到新 Issue
     │
     ▼
创建工作空间 (Git Worktree)
     │
     ▼
启动 Claude Code Agent
     │
     ▼
执行中 ──► 事件推送 ──► Dashboard + Telegram
     │
     ▼
完成 ──► 更新 Linear 状态 + 发表评论
     │
     ▼
推送完成通知到 Telegram
```

**Agent 执行流程：**
```
Orchestrator
     │
     ▼
创建 Agent Session (Claude Code Library)
     │
     ▼
注册事件回调：
  • on_tool_call    ──► 记录到 DB + 推送到 Dashboard
  • on_file_change  ──► 记录到 DB + 推送到 Dashboard
  • on_thought      ──► 记录到 DB (可选推送)
  • on_milestone    ──► 推送 Telegram
  • on_complete     ──► 更新状态 + 推送 Telegram
     │
     ▼
Agent 执行完成
     │
     ▼
清理/归档工作空间
```

---

## 3. 核心模块设计

### 3.1 Orchestrator（编排器）

**职责：**
- 轮询 Linear，检测新 issue
- 管理任务队列和并发控制
- 状态持久化与恢复
- 异常处理与重试

**核心接口：**
```typescript
interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
  addTask(issueId: string): Promise<void>;
  pauseTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  getQueueStatus(): QueueStatus;
  getTask(taskId: string): Task | null;
}

interface QueueStatus {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}
```

**并发控制：**
```typescript
const config = {
  maxParallelTasks: 3,  // 可配置
  queueStrategy: 'priority',
};
```

### 3.2 Linear Client

**配置：
```yaml
tracker:
  linear:
    api_key: $LINEAR_API_KEY
    poll_interval: 30s
    trigger:
      label: "auto-fix"
      status: "In Progress"
      assignee: "symphony-bot"
    update:
      on_start: "In Progress"
      on_complete: "Done"
      on_error: "Blocked"
      add_comment: true
```

### 3.3 Workspace Manager

**目录结构：
```
~/.symphony/workspaces/
├── ISSUE-123/
│   ├── .git/worktrees/...
│   └── (代码文件)
├── ISSUE-456/
└── ...
```

### 3.4 Claude Code Runtime

**集成方式：** Library 嵌入（非 CLI 调用）

**事件类型：**
| 事件类型 | 说明 | 推送策略 |
|----------|------|----------|
| `thought` | Agent 思考 | 记录，不推送 |
| `tool_call` | 调用工具 | 记录 + Dashboard 实时更新 |
| `tool_complete` | 工具完成 | 记录 + Dashboard 更新 |
| `file_change` | 文件修改 | 记录 + Dashboard 更新 |
| `milestone` | 关键里程碑 | 记录 + Telegram 推送 |
| `error` | 错误 | 记录 + Telegram 推送 |
| `complete` | 任务完成 | 记录 + Telegram 推送 |

### 3.5 SQLite 数据模型

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  issue_title TEXT,
  status TEXT NOT NULL,
  priority INTEGER DEFAULT 2,
  workflow TEXT DEFAULT 'auto-fix',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,
  git_branch TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  cleaned_at TIMESTAMP
);

CREATE TABLE execution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  event_data JSON NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 3.6 Telegram Bot

**框架：** grammy

**命令列表：**
- `/new_issue` - 创建新 Issue (交互式)
- `/issue` - 快速创建 Issue
- `/my_issues` - 查看我创建的 Issues
- `/start` - 启动指定 Issue 的 Agent
- `/pause` - 暂停运行中的任务
- `/cancel` - 取消任务
- `/status` - 查看任务状态
- `/help` - 帮助信息
- `/settings` - 个人设置

### 3.7 HTTP API Server

**技术栈：** Bun + Hono

**API 端点：**
- `GET /api/v1/tasks` - 获取任务列表
- `GET /api/v1/tasks/:id` - 获取任务详情
- `POST /api/v1/tasks/:id/pause` - 暂停任务
- `POST /api/v1/tasks/:id/cancel` - 取消任务
- `GET /api/v1/stats` - 获取统计数据
- `WS /ws/tasks/:id` - 订阅任务实时事件

---

## 4. 用户界面设计

### 4.1 Web Dashboard - 任务列表页

- 今日统计卡片（运行中、完成、失败、花费）
- 任务列表表格（状态、标题、优先级、进度、耗时、操作）
- 新建任务按钮

### 4.2 Web Dashboard - 任务详情页

- 状态栏（运行状态、进度条、耗时）
- 摘要卡片（已分析问题、已修改文件、测试结果、下一步）
- 视图切换（摘要、实时日志、文件对比、完整事件）
- 实时日志流（自动滚动）
- 修改文件列表

### 4.3 Telegram 通知样式

**任务完成通知：**
```
✅ 任务完成

📋 ISSUE-123: 修复用户登录 bug

✅ 修改文件：src/auth/session.ts
✅ 测试结果：12/12 通过
📊 耗时：5m 20s
💰 花费：$0.42

[📊 查看完整报告] [📝 查看代码对比] [🔗 Linear]
```

---

## 5. 安全与权限

### 5.1 双模式设计

**全自动模式 (Auto Mode)：**
- 所有操作自动执行，无需审批
- 适合受信任的工作流程
- 事后通知：关键操作完成后汇总汇报

**谨慎模式 (Guarded Mode)：**
- 高风险操作需要实时审批
- 适合探索性任务/生产环境
- 醒目提醒：Telegram 弹窗 + Dashboard 高亮

### 5.2 Telegram Bot 安全

```yaml
telegram:
  allowed_users: [$TELEGRAM_USER_ID_1]
  admin_users: [$TELEGRAM_USER_ID_1]
  command_permissions:
    "/new_issue": "all"
    "/start": "admin"
    "/cancel": "admin"
```

### 5.3 审计日志

- 记录所有事件，保留 30 天
- 可查询：任务历史、文件变更、审批决策、错误事件

---

## 6. 部署与运维

### 6.1 一键部署脚本

```bash
#!/bin/bash
curl -fsSL https://symphony.dev/install.sh | bash
symphony config  # 交互式配置
symphony start
```

### 6.2 错误恢复策略

```yaml
recovery:
  api_retry:
    max_retries: 5
    backoff_ms: 1000
    backoff_max_ms: 300000
  state_recovery:
    enabled: true
    restore_running_tasks: true
  anomaly_detection:
    max_iterations: 50
    timeout_ms: 3600000
```

### 6.3 监控与告警

```yaml
alerts:
  - task_failure_rate > 20%
  - disk_usage > 80%
  - daily_cost > 100
```

---

## 7. MVP 功能清单

### 7.1 核心功能（必须）

| 模块 | 功能 | 优先级 |
|------|------|--------|
| Symphony 核心 | Linear 轮询、Git Worktree、Claude Code Library、SQLite、自动模式 | 🔴 |
| Web Dashboard | 任务列表页、任务详情页 | 🔴 |
| Telegram Bot | /new_issue、任务完成通知、控制命令 | 🔴 |
| 错误恢复 | API 重试、状态恢复 | 🔴 |
| 部署 | 一键安装脚本、配置向导 | 🟡 |

### 7.2 阶段 2 功能（延后）

- Telegram Web App
- 谨慎模式 + 审批流程
- 智能 Issue 解析
- 多工作流支持
- 监控告警
- 自动备份

---

## 8. 开发计划

### 8.1 时间线

```
Week 1-2: Symphony 核心增强
  - HTTP Server + REST API
  - Claude Code Library 嵌入
  - SQLite 数据模型与存储层
  - Linear Client 增强
  - 错误恢复机制

Week 3: Web Dashboard (MVP)
  - 任务列表页
  - 任务详情页 (WebSocket 实时日志)
  - 基础设置页
  - 花费统计组件

Week 4: Telegram Bot (MVP)
  - /new_issue 命令（交互式）
  - 通知推送
  - 简单控制命令
  - 帮助系统

Week 5: 集成测试 + 文档
  - 端到端测试
  - 部署文档
  - 用户指南
```

### 8.2 技术依赖

```json
{
  "runtime": "Bun",
  "web_framework": "Hono",
  "database": "better-sqlite3",
  "telegram_bot": "grammy",
  "frontend": "React + Vite + Tailwind CSS",
  "ui_components": "shadcn/ui"
}
```

### 8.3 成功标准

MVP 完成的标准：
1. ✅ 用户可以一键部署到 VPS
2. ✅ 配置完成后，Linear 添加标签 → Agent 自动执行
3. ✅ Web Dashboard 可实时查看进度和日志
4. ✅ Telegram 可创建 Issue 并接收完成通知
5. ✅ 重启后可恢复运行状态
6. ✅ API 异常时自动重试

---

## 附录

### A. 术语表

| 术语 | 说明 |
|------|------|
| Symphony | 企业级自动化编排服务 |
| Claude Code | AI 代码执行 Agent |
| Linear | 项目管理工具（Issue 追踪） |
| Telegram Bot | 移动端控制入口 |
| Web Dashboard | Web 可视化界面 |
| Worktree | Git 工作空间隔离 |

### B. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Claude API 不稳定 | 任务失败 | 指数退避重试 |
| VPS 资源不足 | 并发受限 | 默认 3 并发，可配置 |
| Git 冲突 | 任务阻塞 | 暂停 + 通知用户介入 |
| Telegram 被封 | 移动控制失效 | 降级到 Web Dashboard |

---

**文档结束**
