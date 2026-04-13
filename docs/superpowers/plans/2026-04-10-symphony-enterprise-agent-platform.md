# Symphony 企业级软件开发代理平台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个结合 OpenAI Symphony 编排流程 + Claude Code 执行能力 + Web Dashboard + Telegram Bot 的企业级自动化开发平台

**Architecture:** 
- 在现有 Symphony 项目 (`/home/agent/test-cc`) 基础上扩展
- 添加 HTTP Server (Bun + Hono) 提供 REST API + WebSocket
- 嵌入 Claude Code Library 作为执行引擎 (替换现有 Codex Agent)
- 添加 Telegram Bot (grammy 框架)
- 添加 Web Dashboard (React + Vite + Tailwind + shadcn/ui)
- SQLite 持久化状态

**Tech Stack:** Bun, Hono, better-sqlite3, grammy, React, Vite, Tailwind CSS, shadcn/ui, WebSocket

**项目前提:**
- 基础 Symphony 项目已在 `/home/agent/test-cc` 
- Claude Code 源代码在 `/home/agent/cc-haha` 可用于参考集成
- 需要迁移到 Bun 运行时（当前使用 Node.js）

---

## 文件结构总览

**新增文件：**
```
src/
├── server/                      # HTTP Server (NEW)
│   ├── index.ts                 # Hono server entry
│   ├── routes/
│   │   ├── tasks.ts             # /api/v1/tasks routes
│   │   ├── stats.ts             # /api/v1/stats routes
│   │   └── health.ts            # /api/v1/health
│   ├── websocket/
│   │   └── taskEvents.ts        # WebSocket handler for real-time events
│   └── types.ts                 # Server types
├── database/                    # SQLite Database (NEW)
│   ├── index.ts                 # Database connection
│   ├── schema.ts                # SQL schema
│   └── repositories/
│       ├── taskRepository.ts    # Task CRUD
│       └── eventRepository.ts   # Event storage
├── telegram/                    # Telegram Bot (NEW)
│   ├── index.ts                 # Bot entry
│   ├── commands/
│   │   ├── newIssue.ts          # /new_issue handler
│   │   ├── start.ts             # /start handler
│   │   ├── pause.ts             # /pause handler
│   │   ├── cancel.ts            # /cancel handler
│   │   ├── status.ts            # /status handler
│   │   └── help.ts              # /help handler
│   ├── notifications.ts         # Notification sender
│   └── types.ts                 # Bot types
├── claude-runtime/              # Claude Code Runtime (NEW)
│   ├── index.ts                 # Runtime entry
│   ├── session.ts               # Agent session management
│   └── eventHandler.ts          # Event callback handler
└── web-dashboard/               # Web Dashboard (NEW - separate Vite project)
    ├── src/
    │   ├── App.tsx
    │   ├── pages/
    │   │   ├── TaskList.tsx
    │   │   ├── TaskDetail.tsx
    │   │   └── Settings.tsx
    │   ├── components/
    │   └── api/
    └── package.json
```

**修改文件：**
```
src/orchestrator/index.ts        # 集成 Claude Runtime + 数据库 + 事件推送
src/agent/runner.ts              # 替换为 Claude Code 执行
src/cli/index.ts                 # 添加 server 启动逻辑
package.json                     # 添加依赖 + Bun 配置
```

---

## Phase 1: 基础架构 (Week 1-2)

### Task 1: 项目迁移到 Bun 运行时

**Files:**
- Modify: `package.json`
- Create: `bunfig.toml`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: 更新 package.json 添加 Bun 依赖**

```json
{
  "name": "symphony",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "bun build src/cli/index.ts --outdir dist",
    "start": "bun run src/cli/index.ts",
    "dev": "bun --watch src/cli/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.80.0",
    "chokidar": "^3.6.0",
    "graphql": "^16.8.0",
    "liquidjs": "^10.11.0",
    "uuid": "^9.0.0",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "@types/bun": "^1.0.0",
    "@types/uuid": "^9.0.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: 创建 bunfig.toml**

```toml
[install]
registry = "https://registry.npmjs.org"

[run]
shell = "bash"
```

- [ ] **Step 3: 安装依赖**

```bash
cd /home/agent/test-cc
bun install
```

Expected: All dependencies installed successfully

- [ ] **Step 4: 更新 tsconfig.json 支持 ES Modules**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "lib": ["ES2022"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: 验证项目可以运行**

```bash
cd /home/agent/test-cc
bun run dev --help
```

Expected: CLI help output appears

- [ ] **Step 6: Commit**

```bash
git add package.json bunfig.toml tsconfig.json
git commit -m "chore: migrate to Bun runtime"
```

---

### Task 2: SQLite 数据库层

**Files:**
- Create: `src/database/index.ts`
- Create: `src/database/schema.ts`
- Create: `src/database/repositories/taskRepository.ts`
- Create: `src/database/repositories/eventRepository.ts`

- [ ] **Step 1: 安装 SQLite 依赖**

```bash
cd /home/agent/test-cc
bun add better-sqlite3
bun add -d @types/better-sqlite3
```

Expected: Package installed successfully

- [ ] **Step 2: 创建数据库连接模块 `src/database/index.ts`**

```typescript
import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = join(process.env.SYMPHONY_DATA_DIR || '.', 'symphony.db');

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize schema
export { initializeSchema } from './schema';
export { taskRepository } from './repositories/taskRepository';
export { eventRepository } from './repositories/eventRepository';

export type { Task, TaskStatus, CreateTaskInput } from './repositories/taskRepository';
export type { ExecutionEvent, EventType } from './repositories/eventRepository';
```

- [ ] **Step 3: 创建数据库 Schema `src/database/schema.ts`**

```typescript
import { db } from './index';

export function initializeSchema(): void {
  db.exec(`
    -- Tasks table
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 2,
      workflow TEXT DEFAULT 'auto-fix',
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0
    );

    -- Workspaces table
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      path TEXT NOT NULL,
      git_branch TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      cleaned_at TEXT
    );

    -- Execution events table
    CREATE TABLE IF NOT EXISTS execution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_issue ON tasks(issue_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON execution_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON execution_events(timestamp);
  `);
}
```

- [ ] **Step 4: 创建 Task Repository `src/database/repositories/taskRepository.ts`**

```typescript
import { db } from '../index';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

export interface Task {
  id: string;
  issue_id: string;
  issue_title: string;
  status: TaskStatus;
  priority: number;
  workflow: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  retry_count: number;
}

export interface CreateTaskInput {
  issue_id: string;
  issue_title: string;
  priority?: number;
  workflow?: string;
}

export const taskRepository = {
  create(input: CreateTaskInput): Task {
    const id = crypto.randomUUID();
    const stmt = db.prepare(`
      INSERT INTO tasks (id, issue_id, issue_title, status, priority, workflow)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);
    stmt.run(id, input.issue_id, input.issue_title, input.priority ?? 2, input.workflow ?? 'auto-fix');
    return this.findById(id)!;
  },

  findById(id: string): Task | null {
    const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    return stmt.get(id) as Task | null;
  },

  findByIssueId(issueId: string): Task | null {
    const stmt = db.prepare('SELECT * FROM tasks WHERE issue_id = ?');
    return stmt.get(issueId) as Task | null;
  },

  findAll(status?: TaskStatus): Task[] {
    const stmt = status
      ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC')
      : db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
    return stmt.all(status) as Task[];
  },

  updateStatus(id: string, status: TaskStatus, error?: string): void {
    const updates: string[] = ['status = ?'];
    const params: any[] = [status];

    if (status === 'running') {
      updates.push('started_at = datetime(\'now\')');
    } else if (status === 'completed' || status === 'failed') {
      updates.push('completed_at = datetime(\'now\')');
      if (error) {
        updates.push('error_message = ?');
        params.push(error);
      }
    }

    const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...params, id);
  },

  incrementRetryCount(id: string): void {
    const stmt = db.prepare('UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?');
    stmt.run(id);
  },

  delete(id: string): void {
    const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    stmt.run(id);
  }
};
```

- [ ] **Step 5: 创建 Event Repository `src/database/repositories/eventRepository.ts`**

```typescript
import { db } from '../index';

export type EventType = 
  | 'thought'
  | 'tool_call'
  | 'tool_complete'
  | 'file_change'
  | 'milestone'
  | 'error'
  | 'complete';

export interface ExecutionEvent {
  id: number;
  task_id: string;
  event_type: EventType;
  event_data: Record<string, any>;
  timestamp: string;
}

export const eventRepository = {
  create(taskId: string, eventType: EventType, eventData: Record<string, any>): ExecutionEvent {
    const stmt = db.prepare(`
      INSERT INTO execution_events (task_id, event_type, event_data)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(taskId, eventType, JSON.stringify(eventData));
    return this.findById(result.lastInsertRowid as number)!;
  },

  findById(id: number): ExecutionEvent | null {
    const stmt = db.prepare('SELECT * FROM execution_events WHERE id = ?');
    const row = stmt.get(id) as { id: number; task_id: string; event_type: string; event_data: string; timestamp: string } | null;
    if (!row) return null;
    return {
      ...row,
      event_data: JSON.parse(row.event_data)
    };
  },

  findByTaskId(taskId: string, limit = 100): ExecutionEvent[] {
    const stmt = db.prepare(`
      SELECT * FROM execution_events 
      WHERE task_id = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
    const rows = stmt.all(taskId, limit) as any[];
    return rows.map(row => ({
      ...row,
      event_data: JSON.parse(row.event_data)
    }));
  },

  streamByTaskId(taskId: string, callback: (event: ExecutionEvent) => void): () => void {
    const stmt = db.prepare(`
      SELECT * FROM execution_events 
      WHERE task_id = ? 
      ORDER BY id DESC
    `);
    
    const cursor = stmt.iterate(taskId) as IterableIterator<any>;
    let done = false;

    const poll = () => {
      if (done) return;
      const result = cursor.next();
      if (!result.done) {
        const row = result.value;
        callback({
          ...row,
          event_data: JSON.parse(row.event_data)
        });
        setTimeout(poll, 1000);
      }
    };

    poll();

    return () => { done = true; };
  }
};
```

- [ ] **Step 6: 编写数据库测试**

Create: `src/database/index.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { db, initializeSchema } from './index';
import { taskRepository } from './repositories/taskRepository';
import { eventRepository } from './repositories/eventRepository';

describe('Database', () => {
  beforeEach(() => {
    initializeSchema();
    // Clear tables
    db.exec('DELETE FROM execution_events');
    db.exec('DELETE FROM workspaces');
    db.exec('DELETE FROM tasks');
  });

  describe('taskRepository', () => {
    it('creates a task', () => {
      const task = taskRepository.create({
        issue_id: 'TEST-123',
        issue_title: 'Test Issue'
      });

      expect(task.id).toBeDefined();
      expect(task.issue_id).toBe('TEST-123');
      expect(task.status).toBe('pending');
    });

    it('finds task by id', () => {
      const created = taskRepository.create({
        issue_id: 'TEST-456',
        issue_title: 'Find Test'
      });

      const found = taskRepository.findById(created.id);
      expect(found?.issue_id).toBe('TEST-456');
    });

    it('updates task status', () => {
      const task = taskRepository.create({
        issue_id: 'TEST-789',
        issue_title: 'Status Test'
      });

      taskRepository.updateStatus(task.id, 'running');
      const updated = taskRepository.findById(task.id);
      expect(updated?.status).toBe('running');
      expect(updated?.started_at).toBeDefined();
    });
  });

  describe('eventRepository', () => {
    it('creates an event', () => {
      const task = taskRepository.create({
        issue_id: 'TEST-EVT',
        issue_title: 'Event Test'
      });

      const event = eventRepository.create(task.id, 'thought', { content: 'Thinking...' });
      expect(event.task_id).toBe(task.id);
      expect(event.event_type).toBe('thought');
      expect(event.event_data.content).toBe('Thinking...');
    });

    it('finds events by task id', () => {
      const task = taskRepository.create({
        issue_id: 'TEST-LIST',
        issue_title: 'List Test'
      });

      eventRepository.create(task.id, 'thought', { content: 'First' });
      eventRepository.create(task.id, 'tool_call', { tool: 'read_file' });
      eventRepository.create(task.id, 'complete', { success: true });

      const events = eventRepository.findByTaskId(task.id);
      expect(events.length).toBe(3);
    });
  });
});
```

- [ ] **Step 7: 运行数据库测试**

```bash
cd /home/agent/test-cc
bun test src/database/index.test.ts
```

Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/database/
git commit -m "feat: add SQLite database layer with task and event repositories"
```

---

### Task 3: Claude Code Runtime 集成

**Files:**
- Create: `src/claude-runtime/index.ts`
- Create: `src/claude-runtime/session.ts`
- Create: `src/claude-runtime/eventHandler.ts`

- [ ] **Step 1: 安装 Claude Code 相关依赖**

```bash
cd /home/agent/cc-haha
bun link

cd /home/agent/test-cc
bun link @claude-code/runtime
```

Note: 如果 Claude Code 没有作为包导出，需要直接从源码导入

Alternative approach - copy required modules:

```bash
# Copy Claude Code runtime modules to test-cc
cp -r /home/agent/cc-haha/src/entrypoints /home/agent/test-cc/src/claude-code/
cp -r /home/agent/cc-haha/src/services /home/agent/test-cc/src/claude-code/services/
```

- [ ] **Step 2: 创建 Claude Runtime 入口 `src/claude-runtime/index.ts`**

```typescript
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';

export interface ClaudeRuntimeConfig {
  workspacePath: string;
  prompt: string;
  model?: string;
  maxIterations?: number;
}

export interface ClaudeEvent {
  type: 'thought' | 'tool_call' | 'tool_complete' | 'file_change' | 'milestone' | 'error' | 'complete';
  data: Record<string, any>;
  timestamp: Date;
}

export type ClaudeEventHandler = (event: ClaudeEvent) => void;

export class ClaudeRuntime extends EventEmitter {
  private process: any = null;
  private config: ClaudeRuntimeConfig;

  constructor(config: ClaudeRuntimeConfig) {
    super();
    this.config = config;
  }

  /**
   * Start Claude Code agent session
   */
  async start(onEvent: ClaudeEventHandler): Promise<void> {
    return new Promise((resolve, reject) => {
      // Spawn claude-haha as subprocess
      this.process = spawn('bun', [
        '/home/agent/cc-haha/src/entrypoints/cli.tsx',
        '--bare',
        '-p',
        this.config.prompt
      ], {
        cwd: this.config.workspacePath,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const rl = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity
      });

      rl.on('line', (line) => {
        const event = this.parseOutputLine(line);
        if (event) {
          onEvent(event);
          this.emit('event', event);
        }

        // Check for completion
        if (line.includes('Task completed') || line.includes('Goodbye!')) {
          resolve();
        }
      });

      this.process.stderr.on('data', (data: Buffer) => {
        const error = data.toString();
        onEvent({
          type: 'error',
          data: { message: error },
          timestamp: new Date()
        });
      });

      this.process.on('error', (err: Error) => {
        reject(err);
      });

      this.process.on('exit', (code: number) => {
        if (code === 0) {
          onEvent({
            type: 'complete',
            data: { success: true },
            timestamp: new Date()
          });
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Parse Claude Code output line into structured event
   */
  private parseOutputLine(line: string): ClaudeEvent | null {
    // Parse JSON events from Claude Code output
    try {
      if (line.startsWith('{')) {
        const parsed = JSON.parse(line);
        return this.mapClaudeEvent(parsed);
      }
    } catch {
      // Not JSON, skip
    }

    // Parse text events
    if (line.includes('Thinking...')) {
      return {
        type: 'thought',
        data: { content: line },
        timestamp: new Date()
      };
    }

    if (line.includes('Reading file:')) {
      const filePath = line.split('Reading file:')[1].trim();
      return {
        type: 'tool_call',
        data: { tool: 'read_file', path: filePath },
        timestamp: new Date()
      };
    }

    if (line.includes('Writing to:')) {
      const filePath = line.split('Writing to:')[1].trim();
      return {
        type: 'file_change',
        data: { action: 'write', path: filePath },
        timestamp: new Date()
      };
    }

    return null;
  }

  /**
   * Map Claude Code internal events to our event format
   */
  private mapClaudeEvent(event: any): ClaudeEvent | null {
    if (!event.type) return null;

    const eventTypeMap: Record<string, ClaudeEvent['type']> = {
      'assistant_response': 'thought',
      'tool_use': 'tool_call',
      'tool_result': 'tool_complete',
      'file_edit': 'file_change',
      'error': 'error',
      'done': 'complete'
    };

    const type = eventTypeMap[event.type];
    if (!type) return null;

    return {
      type,
      data: event.data || event,
      timestamp: new Date()
    };
  }

  /**
   * Stop the running session
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}
```

- [ ] **Step 3: 创建 Session 管理器 `src/claude-runtime/session.ts`**

```typescript
import { ClaudeRuntime, ClaudeEvent, ClaudeRuntimeConfig } from './index';
import { eventRepository } from '../database/repositories/eventRepository';

export interface SessionState {
  id: string;
  taskId: string;
  status: 'starting' | 'running' | 'paused' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  events: ClaudeEvent[];
}

export class ClaudeSessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private runtimes: Map<string, ClaudeRuntime> = new Map();

  /**
   * Create and start a new session
   */
  async createSession(
    taskId: string,
    config: ClaudeRuntimeConfig,
    onEvent?: (event: ClaudeEvent) => void
  ): Promise<string> {
    const sessionId = crypto.randomUUID();
    
    const state: SessionState = {
      id: sessionId,
      taskId,
      status: 'starting',
      createdAt: new Date(),
      events: []
    };

    this.sessions.set(sessionId, state);

    const runtime = new ClaudeRuntime(config);
    this.runtimes.set(sessionId, runtime);

    // Set up event handler
    runtime.on('event', (event) => {
      state.events.push(event);

      // Store event in database
      eventRepository.create(taskId, event.type, event.data);

      // Forward to callback
      if (onEvent) {
        onEvent(event);
      }

      // Update session state
      if (event.type === 'complete') {
        state.status = 'completed';
        state.completedAt = new Date();
      } else if (event.type === 'error') {
        state.status = 'failed';
        state.completedAt = new Date();
      }
    });

    // Start runtime
    state.status = 'running';
    await runtime.start((event) => {
      state.events.push(event);
      eventRepository.create(taskId, event.type, event.data);
      if (onEvent) onEvent(event);
    });

    return sessionId;
  }

  /**
   * Get session state
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Stop a session
   */
  async stopSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'completed';
      session.completedAt = new Date();
    }
  }

  /**
   * Get all sessions for a task
   */
  getSessionsByTask(taskId: string): SessionState[] {
    return Array.from(this.sessions.values()).filter(s => s.taskId === taskId);
  }

  /**
   * Get live events for a session (for WebSocket streaming)
   */
  getLiveEvents(sessionId: string): ClaudeEvent[] {
    const session = this.sessions.get(sessionId);
    return session?.events || [];
  }
}

export const sessionManager = new ClaudeSessionManager();
```

- [ ] **Step 4: 创建 Event Handler 集成 `src/claude-runtime/eventHandler.ts`**

```typescript
import { ClaudeEvent } from './index';
import { eventRepository } from '../database/repositories/eventRepository';
import { taskRepository } from '../database/repositories/taskRepository';

/**
 * Process Claude events and trigger appropriate actions
 */
export async function handleClaudeEvent(
  taskId: string,
  event: ClaudeEvent
): Promise<void> {
  // Store event
  eventRepository.create(taskId, event.type, event.data);

  // Handle specific event types
  switch (event.type) {
    case 'milestone':
      // Send Telegram notification for milestones
      await notifyTelegramMilestone(taskId, event.data);
      break;

    case 'error':
      // Update task status on error
      taskRepository.updateStatus(taskId, 'failed', event.data.message);
      await notifyTelegramError(taskId, event.data);
      break;

    case 'complete':
      // Update task status on completion
      taskRepository.updateStatus(taskId, 'completed');
      await notifyTelegramComplete(taskId, event.data);
      break;
  }

  // Broadcast to WebSocket clients
  broadcastToWebSocket(taskId, event);
}

async function notifyTelegramMilestone(taskId: string, data: any): Promise<void> {
  // Placeholder - will be implemented in Telegram task
  console.log('[telegram] Milestone for task', taskId, ':', data);
}

async function notifyTelegramError(taskId: string, data: any): Promise<void> {
  // Placeholder - will be implemented in Telegram task
  console.log('[telegram] Error for task', taskId, ':', data.message);
}

async function notifyTelegramComplete(taskId: string, data: any): Promise<void> {
  // Placeholder - will be implemented in Telegram task
  console.log('[telegram] Complete for task', taskId, ':', data);
}

function broadcastToWebSocket(taskId: string, event: ClaudeEvent): void {
  // Placeholder - will be implemented in WebSocket task
  console.log('[websocket] Broadcasting event to task', taskId, ':', event.type);
}
```

- [ ] **Step 5: 编写 Runtime 测试**

Create: `src/claude-runtime/index.test.ts`

```typescript
import { describe, it, expect } from 'bun:test';
import { ClaudeRuntime } from './index';
import { ClaudeSessionManager } from './session';

describe('ClaudeRuntime', () => {
  it('can be instantiated', () => {
    const runtime = new ClaudeRuntime({
      workspacePath: '/tmp/test',
      prompt: 'Test prompt'
    });
    expect(runtime).toBeDefined();
  });
});

describe('ClaudeSessionManager', () => {
  const manager = new ClaudeSessionManager();

  it('creates a session state', async () => {
    const sessionId = await manager.createSession(
      'task-123',
      {
        workspacePath: '/tmp/test',
        prompt: 'Test'
      },
      () => {}
    );
    
    const session = manager.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session?.taskId).toBe('task-123');
    expect(session?.status).toBe('running');
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add src/claude-runtime/
git commit -m "feat: add Claude Code runtime integration layer"
```

---

### Task 4: HTTP Server (Hono)

**Files:**
- Create: `src/server/index.ts`
- Create: `src/server/types.ts`
- Create: `src/server/routes/tasks.ts`
- Create: `src/server/routes/stats.ts`
- Create: `src/server/routes/health.ts`
- Create: `src/server/websocket/taskEvents.ts`

- [ ] **Step 1: 安装 Hono 和 WebSocket 依赖**

```bash
cd /home/agent/test-cc
bun add hono @hono/node-ws
```

Expected: Packages installed successfully

- [ ] **Step 2: 创建服务器类型定义 `src/server/types.ts`**

```typescript
import { Task } from '../database/repositories/taskRepository';
import { ExecutionEvent } from '../database/repositories/eventRepository';
import { ClaudeEvent } from '../claude-runtime';

export interface TaskResponse {
  id: string;
  issue_id: string;
  issue_title: string;
  status: string;
  priority: number;
  progress: number;
  elapsed_seconds: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface StatsResponse {
  running: number;
  completed: number;
  failed: number;
  pending: number;
  cost_today: number;
  cost_this_month: number;
}

export interface WebSocketMessage {
  type: 'event' | 'status';
  taskId: string;
  data: ClaudeEvent | Task;
  timestamp: string;
}

export interface ServerConfig {
  port: number;
  host?: string;
}
```

- [ ] **Step 3: 创建服务器入口 `src/server/index.ts`**

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from 'bun';
import { initializeSchema, db } from '../database';
import { tasksRouter } from './routes/tasks';
import { statsRouter } from './routes/stats';
import { healthRouter } from './routes/health';
import { setupWebSocket } from './websocket/taskEvents';
import type { ServerConfig } from './types';

export class SymphonyServer {
  private app: Hono;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.app = new Hono();
  }

  async start(): Promise<void> {
    // Initialize database
    initializeSchema();
    console.log('[server] Database initialized');

    // Middleware
    this.app.use('/*', cors());
    this.app.use('/*', async (c, next) => {
      console.log(`[server] ${c.req.method} ${c.req.path}`);
      await next();
    });

    // Routes
    this.app.route('/api/v1/tasks', tasksRouter);
    this.app.route('/api/v1/stats', statsRouter);
    this.app.route('/api/v1', healthRouter);

    // WebSocket
    setupWebSocket(this.app);

    // Health check
    this.app.get('/', (c) => {
      return c.json({ 
        name: 'Symphony',
        version: '1.0.0',
        status: 'ok'
      });
    });

    // Start server
    serve({
      port: this.config.port,
      hostname: this.config.host || '0.0.0.0',
      fetch: this.app.fetch
    }, (info) => {
      console.log(`[server] Listening on http://${this.config.host || '0.0.0.0'}:${this.config.port}`);
    });
  }

  async stop(): Promise<void> {
    db.close();
    console.log('[server] Stopped');
  }
}

export { startServer };

function startServer(port?: number): SymphonyServer {
  const server = new SymphonyServer({
    port: port ?? 8080
  });
  server.start();
  return server;
}
```

- [ ] **Step 4: 创建 Tasks 路由 `src/server/routes/tasks.ts`**

```typescript
import { Hono } from 'hono';
import { taskRepository, TaskStatus } from '../../database/repositories/taskRepository';
import { eventRepository } from '../../database/repositories/eventRepository';
import type { TaskResponse } from '../types';

export const tasksRouter = new Hono();

// GET /api/v1/tasks - List all tasks
tasksRouter.get('/', (c) => {
  const status = c.req.query('status') as TaskStatus | undefined;
  const tasks = taskRepository.findAll(status);

  const response: TaskResponse[] = tasks.map(task => ({
    ...task,
    progress: calculateProgress(task),
    elapsed_seconds: calculateElapsedSeconds(task)
  }));

  return c.json(response);
});

// GET /api/v1/tasks/:id - Get task by ID
tasksRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const task = taskRepository.findById(id);

  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const response: TaskResponse = {
    ...task,
    progress: calculateProgress(task),
    elapsed_seconds: calculateElapsedSeconds(task)
  };

  return c.json(response);
});

// GET /api/v1/tasks/:id/events - Get task events
tasksRouter.get('/:id/events', (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '100');
  const events = eventRepository.findByTaskId(id, limit);
  return c.json(events);
});

// POST /api/v1/tasks - Create new task
tasksRouter.post('/', (c) => {
  const body = await c.req.json();
  const task = taskRepository.create({
    issue_id: body.issue_id,
    issue_title: body.issue_title,
    priority: body.priority,
    workflow: body.workflow
  });

  return c.json(task, 201);
});

// POST /api/v1/tasks/:id/pause - Pause task
tasksRouter.post('/:id/pause', (c) => {
  const id = c.req.param('id');
  taskRepository.updateStatus(id, 'paused');
  return c.json({ success: true });
});

// POST /api/v1/tasks/:id/cancel - Cancel task
tasksRouter.post('/:id/cancel', (c) => {
  const id = c.req.param('id');
  taskRepository.updateStatus(id, 'failed', 'Cancelled by user');
  return c.json({ success: true });
});

function calculateProgress(task: any): number {
  if (task.status === 'completed') return 100;
  if (task.status === 'failed') return 0;
  if (task.status === 'pending') return 0;
  // Placeholder - real implementation would track actual progress
  return 50;
}

function calculateElapsedSeconds(task: any): number {
  const start = task.started_at ? new Date(task.started_at) : new Date(task.created_at);
  const end = task.completed_at ? new Date(task.completed_at) : new Date();
  return Math.floor((end.getTime() - start.getTime()) / 1000);
}
```

- [ ] **Step 5: 创建 Stats 路由 `src/server/routes/stats.ts`**

```typescript
import { Hono } from 'hono';
import { db } from '../../database';
import type { StatsResponse } from '../types';

export const statsRouter = new Hono();

// GET /api/v1/stats - Get statistics
statsRouter.get('/', (c) => {
  const running = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?', 'running').get() as any;
  const completed = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?', 'completed').get() as any;
  const failed = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?', 'failed').get() as any;
  const pending = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?', 'pending').get() as any;

  const response: StatsResponse = {
    running: running?.count || 0,
    completed: completed?.count || 0,
    failed: failed?.count || 0,
    pending: pending?.count || 0,
    cost_today: 0,  // Placeholder
    cost_this_month: 0  // Placeholder
  };

  return c.json(response);
});

// GET /api/v1/stats/cost - Get cost statistics
statsRouter.get('/cost', (c) => {
  // Placeholder - would integrate with Claude API cost tracking
  return c.json({
    today: 0,
    this_month: 0,
    projected_month_end: 0
  });
});
```

- [ ] **Step 6: 创建 Health 路由 `src/server/routes/health.ts`**

```typescript
import { Hono } from 'hono';

export const healthRouter = new Hono();

// GET /api/v1/health - Health check
healthRouter.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// GET /api/v1/metrics - Prometheus metrics (placeholder)
healthRouter.get('/metrics', (c) => {
  const metrics = `
# HELP symphony_tasks_running Number of running tasks
# TYPE symphony_tasks_running gauge
symphony_tasks_running 0

# HELP symphony_tasks_completed Number of completed tasks
# TYPE symphony_tasks_completed gauge
symphony_tasks_completed 0
  `.trim();

  return c.text(metrics, {
    headers: { 'Content-Type': 'text/plain' }
  });
});
```

- [ ] **Step 7: 创建 WebSocket 处理器 `src/server/websocket/taskEvents.ts`**

```typescript
import { Hono } from 'hono';
import type { WebSocketMessage } from '../types';

const clients: Map<string, Set<any>> = new Map();

export function setupWebSocket(app: Hono): void {
  app.get('/ws/tasks/:id', (c) => {
    const taskId = c.req.param('id');
    
    // Upgrade to WebSocket
    const [client, ws] = c.upgradeWebSocket((c) => {
      return {
        onOpen: (_evt, ws) => {
          console.log('[websocket] Client connected to task', taskId);
          if (!clients.has(taskId)) {
            clients.set(taskId, new Set());
          }
          clients.get(taskId)!.add(ws);
        },
        onClose: (_evt, ws) => {
          console.log('[websocket] Client disconnected from task', taskId);
          clients.get(taskId)?.delete(ws);
        },
        onMessage: (evt, ws) => {
          console.log('[websocket] Message:', evt.data);
        }
      };
    });

    return client;
  });
}

export function broadcastToWebSocket(taskId: string, event: any): void {
  const message: WebSocketMessage = {
    type: 'event',
    taskId,
    data: event,
    timestamp: new Date().toISOString()
  };

  const taskClients = clients.get(taskId);
  if (taskClients) {
    const messageStr = JSON.stringify(message);
    for (const client of taskClients) {
      if (client.readyState === 1) {  // WebSocket.OPEN
        client.send(messageStr);
      }
    }
  }
}
```

- [ ] **Step 8: 编写服务器测试**

Create: `src/server/index.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SymphonyServer } from './index';

describe('SymphonyServer', () => {
  let server: SymphonyServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('starts without error', async () => {
    server = new SymphonyServer({ port: 8081 });
    await server.start();
    // If we get here without error, test passes
  });

  it('health endpoint returns ok', async () => {
    server = new SymphonyServer({ port: 8082 });
    await server.start();
    
    const response = await fetch('http://localhost:8082/api/v1/health');
    const data = await response.json();
    expect(data.status).toBe('ok');
  });
});
```

- [ ] **Step 9: Commit**

```bash
git add src/server/
git commit -m "feat: add HTTP server with Hono (REST API + WebSocket)"
```

---

### Task 5: Telegram Bot

**Files:**
- Create: `src/telegram/index.ts`
- Create: `src/telegram/commands/newIssue.ts`
- Create: `src/telegram/commands/start.ts`
- Create: `src/telegram/commands/pause.ts`
- Create: `src/telegram/commands/cancel.ts`
- Create: `src/telegram/commands/status.ts`
- Create: `src/telegram/commands/help.ts`
- Create: `src/telegram/notifications.ts`
- Create: `src/telegram/types.ts`

- [ ] **Step 1: 安装 grammy 依赖**

```bash
cd /home/agent/test-cc
bun add grammy
```

Expected: Package installed successfully

- [ ] **Step 2: 创建 Telegram 类型定义 `src/telegram/types.ts`**

```typescript
export interface TelegramConfig {
  botToken: string;
  allowedUsers?: number[];
  adminUsers?: number[];
}

export interface NotificationConfig {
  onTaskStart?: boolean;
  onTaskComplete?: boolean;
  onTaskError?: boolean;
  onMilestone?: boolean;
}

export type CommandHandler = (ctx: any) => Promise<void>;
```

- [ ] **Step 3: 创建 Telegram Bot 入口 `src/telegram/index.ts`**

```typescript
import { Bot, Context } from 'grammy';
import type { TelegramConfig } from './types';
import { handleNewIssue } from './commands/newIssue';
import { handleStart } from './commands/start';
import { handlePause } from './commands/pause';
import { handleCancel } from './commands/cancel';
import { handleStatus } from './commands/status';
import { handleHelp } from './commands/help';

export class SymphonyBot {
  private bot: Bot;
  private config: TelegramConfig;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.bot = new Bot(config.botToken);
    this.setupCommands();
  }

  private setupCommands(): void {
    // /new_issue - Create new issue interactively
    this.bot.command('new_issue', handleNewIssue);
    
    // /start - Start task for an issue
    this.bot.command('start', handleStart);
    
    // /pause - Pause a running task
    this.bot.command('pause', handlePause);
    
    // /cancel - Cancel a task
    this.bot.command('cancel', handleCancel);
    
    // /status - Check task status
    this.bot.command('status', handleStatus);
    
    // /help - Show help
    this.bot.command('help', handleHelp);

    // Default message handler
    this.bot.on('message:text', async (ctx) => {
      // Forward to new_issue flow if in progress
      // Otherwise, show help
      await ctx.reply('使用 /new_issue 创建新任务，或使用 /help 查看帮助');
    });
  }

  async start(): Promise<void> {
    console.log('[telegram] Starting bot...');
    await this.bot.start();
    console.log('[telegram] Bot started');
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    console.log('[telegram] Bot stopped');
  }

  /**
   * Send notification to user
   */
  async notify(userId: number, message: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(userId, message, {
        parse_mode: 'Markdown'
      });
    } catch (error) {
      console.error('[telegram] Failed to send notification:', error);
    }
  }
}

export function startBot(token?: string): SymphonyBot {
  const botToken = token || process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }

  const bot = new SymphonyBot({
    botToken,
    allowedUsers: [],
    adminUsers: []
  });

  bot.start();
  return bot;
}
```

- [ ] **Step 4: 创建 /new_issue 命令处理器 `src/telegram/commands/newIssue.ts`**

```typescript
import { Context } from 'grammy';

export async function handleNewIssue(ctx: Context): Promise<void> {
  await ctx.reply(
    '📝 *创建新 Issue*\n\n' +
    '请描述你要解决的问题：\n' +
    '_(支持文字、图片、文件)_',
    { parse_mode: 'Markdown' }
  );

  // Note: Full implementation would track conversation state
  // and parse the response to create a Linear issue
}
```

- [ ] **Step 5: 创建 /start 命令处理器 `src/telegram/commands/start.ts`**

```typescript
import { Context } from 'grammy';

export async function handleStart(ctx: Context): Promise<void> {
  const issueId = ctx.match;  // e.g., /start ISSUE-123
  
  if (!issueId) {
    await ctx.reply('请提供 Issue ID，例如：\n`/start ISSUE-123`', {
      parse_mode: 'Markdown'
    });
    return;
  }

  await ctx.reply(`🚀 启动任务：${issueId}\n\nAgent 已启动，正在处理...`);
  
  // Note: Full implementation would trigger orchestrator
}
```

- [ ] **Step 6: 创建 /pause, /cancel, /status 命令处理器**

Create: `src/telegram/commands/pause.ts`
```typescript
import { Context } from 'grammy';

export async function handlePause(ctx: Context): Promise<void> {
  const taskId = ctx.match;
  if (!taskId) {
    await ctx.reply('请提供任务 ID，例如：\n`/pause TASK-123`', {
      parse_mode: 'Markdown'
    });
    return;
  }
  await ctx.reply(`⏸️ 暂停任务：${taskId}`);
}
```

Create: `src/telegram/commands/cancel.ts`
```typescript
import { Context } from 'grammy';

export async function handleCancel(ctx: Context): Promise<void> {
  const taskId = ctx.match;
  if (!taskId) {
    await ctx.reply('请提供任务 ID，例如：\n`/cancel TASK-123`', {
      parse_mode: 'Markdown'
    });
    return;
  }
  await ctx.reply(`❌ 取消任务：${taskId}`);
}
```

Create: `src/telegram/commands/status.ts`
```typescript
import { Context } from 'grammy';

export async function handleStatus(ctx: Context): Promise<void> {
  const taskId = ctx.match;
  if (!taskId) {
    await ctx.reply('请提供任务 ID，例如：\n`/status TASK-123`', {
      parse_mode: 'Markdown'
    });
    return;
  }
  await ctx.reply(`📊 任务状态：${taskId}\n\n状态：运行中\n进度：50%`);
}
```

Create: `src/telegram/commands/help.ts`
```typescript
import { Context } from 'grammy';

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    '📖 *Symphony Bot 帮助*\n\n' +
    '*命令列表:*\n' +
    '/new_issue - 创建新 Issue\n' +
    '/start <ID> - 启动任务\n' +
    '/pause <ID> - 暂停任务\n' +
    '/cancel <ID> - 取消任务\n' +
    '/status <ID> - 查看状态\n' +
    '/help - 显示帮助',
    { parse_mode: 'Markdown' }
  );
}
```

- [ ] **Step 7: 创建通知发送器 `src/telegram/notifications.ts`**

```typescript
import { taskRepository } from '../database/repositories/taskRepository';
import { botInstance } from './index';

export async function sendTaskCompleteNotification(taskId: string): Promise<void> {
  const task = taskRepository.findById(taskId);
  if (!task) return;

  const message = 
    `✅ *任务完成*\n\n` +
    `📋 ${task.issue_title}\n\n` +
    `📊 状态：完成\n` +
    `[📊 查看完整报告](http://localhost:8080/tasks/${taskId})`;

  // Send to all subscribed users
  // Placeholder - would query user subscriptions
  console.log('[telegram] Sending completion notification:', message);
}

export async function sendTaskErrorNotification(taskId: string, error: string): Promise<void> {
  const task = taskRepository.findById(taskId);
  if (!task) return;

  const message = 
    `❌ *任务失败*\n\n` +
    `📋 ${task.issue_title}\n\n` +
    `错误：${error}\n\n` +
    `[🔍 查看详情](http://localhost:8080/tasks/${taskId})`;

  console.log('[telegram] Sending error notification:', message);
}

export async function sendMilestoneNotification(taskId: string, milestone: string): Promise<void> {
  const message = 
    `🎯 *里程碑*\n\n` +
    `任务：${taskId}\n` +
    `进展：${milestone}`;

  console.log('[telegram] Sending milestone notification:', message);
}
```

- [ ] **Step 8: Commit**

```bash
git add src/telegram/
git commit -m "feat: add Telegram bot with basic commands"
```

---

## Phase 2: Web Dashboard (Week 3)

### Task 6: Web Dashboard 基础架构

**Files:**
- Create: `src/web-dashboard/package.json`
- Create: `src/web-dashboard/vite.config.ts`
- Create: `src/web-dashboard/index.html`
- Create: `src/web-dashboard/src/App.tsx`
- Create: `src/web-dashboard/src/main.tsx`

- [ ] **Step 1: 创建 Vite 项目配置**

```json
{
  "name": "symphony-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "@tanstack/react-query": "^5.0.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.32",
    "autoprefixer": "^10.4.16"
  },
  "devDependencies": {
    "@types/react": "^18.2.43",
    "@types/react-dom": "^18.2.17",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.3.3",
    "vite": "^5.0.8"
  }
}
```

- [ ] **Step 2: 创建 Vite 配置 `src/web-dashboard/vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8080'
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
```

- [ ] **Step 3: 创建 HTML 入口 `src/web-dashboard/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Symphony Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: 创建 React 入口 `src/web-dashboard/src/main.tsx`**

```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000,
      retry: 1
    }
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 5: 创建 App 组件 `src/web-dashboard/src/App.tsx`**

```typescript
import { Routes, Route } from 'react-router-dom';
import TaskList from './pages/TaskList';
import TaskDetail from './pages/TaskDetail';
import Settings from './pages/Settings';

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">Symphony Dashboard</h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <Routes>
          <Route path="/" element={<TaskList />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
```

- [ ] **Step 6: Commit**

```bash
git add src/web-dashboard/
git commit -m "feat: add web dashboard foundation (Vite + React)"
```

---

## Phase 3: 集成与测试 (Week 4-5)

### Task 7: 集成测试

### Task 8: 文档

---

## 成功标准

1. ✅ 一键部署到 VPS
2. ✅ Linear 标签触发 → Agent 执行
3. ✅ Web Dashboard 实时查看进度
4. ✅ Telegram 创建 Issue + 接收通知
5. ✅ 重启后恢复状态
6. ✅ API 异常自动重试
