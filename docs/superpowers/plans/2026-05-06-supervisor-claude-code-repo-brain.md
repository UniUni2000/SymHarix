# Supervisor Claude Code Repo Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Telegram supervisor from shallow conversational intake into a repo-aware supervisor that can use the bundled Claude Code runtime to understand configured repositories, answer naturally, recommend artifact/engineering work, and only mutate code after user approval.

**Architecture:** Keep the supervisor as a control shell: Telegram conversation, repo selection, approval, Plan Card, materialization, and execution supervision remain in the existing supervisor/session path. Add a read-only Claude Code repo-understanding layer that runs against configured repository paths, stores structured understanding by repo and commit, and feeds the supervisor agent. Artifact or coding requests become repo-aware recommendations first; approved recommendations continue through the existing session materialization and Claude Code dev-agent execution path.

**Tech Stack:** Bun, TypeScript, SQLite via `bun:sqlite`, existing Telegram bot pipeline, `src/supervisor/*`, `src/bots/*`, existing `scripts/claude-adapter.cjs` / `claude-code/bin/claude-haha`, Bun tests.

---

## Current Reality To Preserve

- Telegram text reaches `BotAssistantService.respondToText` in `src/bots/assistant.ts`.
- The current conversational layer already has `SupervisorAgentService` and `SupervisorCcAdvisor`, but both receive shallow `repo_profile` context rather than a true Claude Code repo read.
- Existing execution already flows through `Orchestrator -> AgentRunner -> scripts/claude-adapter.cjs -> claude-code/bin/claude-haha`.
- `SupervisorSessionService` owns Plan Cards, approval gates, materialization, and root/child session state.
- Approval boundary must remain visible: normal chat and repo answers do not create issues; issue/artifact recommendations wait for explicit approval.

## Subagent Execution Strategy

Use fresh worker subagents one task at a time. After each task:

1. Dispatch a spec-compliance reviewer against this plan section.
2. Fix spec gaps with the same implementer.
3. Dispatch a code-quality reviewer.
4. Fix quality issues with the same implementer.
5. Only then mark the task complete and move to the next task.

Do not dispatch multiple implementers in parallel because the tasks touch adjacent supervisor and database boundaries.

## File Map

- Create `src/database/repositories/supervisorRepoUnderstandingRepository.ts`
  - CRUD for durable repo-understanding snapshots.
- Modify `src/database/schema.ts`
  - Add `supervisor_repo_understandings` table, indexes, initialization, and cleanup.
- Modify `src/database/types.ts`
  - Add entity and create/update types for repo understanding snapshots.
- Modify `src/database/repositories/index.ts`
  - Export the new repository.
- Modify `src/database/index.test.ts`
  - Verify schema and repository behavior.
- Create `src/supervisor/repoUnderstanding.ts`
  - Types, JSON normalization, cache freshness rules, prompt builder, and service interface.
- Create `src/supervisor/claudeRepoUnderstandingService.ts`
  - Read-only Claude Code-backed implementation with deterministic injected runner for tests.
- Create `src/supervisor/claudeRepoUnderstandingService.test.ts`
  - Unit tests for prompt, parsing, cache usage, and no-mutation guardrails.
- Modify `src/supervisor/supervisorAgent.ts`
  - Accept repo understanding, add artifact ideation mode, and preserve conversational behavior.
- Modify `src/supervisor/supervisorAgent.test.ts`
  - Cover repo-aware answers and artifact recommendations.
- Modify `src/bots/runtimeContext.ts`
  - Load repo understanding for the selected configured repo when available.
- Modify `src/bots/types.ts`
  - Add `repo_understanding` to `BotRuntimeCopilotContext`.
- Modify `src/bots/runtimeContext.test.ts`
  - Verify context includes cached understanding.
- Modify `src/bots/assistant.ts`
  - Pass repo understanding to the supervisor agent and map artifact recommendations into the existing session path.
- Modify `src/bots/assistant.test.ts`
  - Cover natural chat, repo answer, artifact recommendation, and approval boundary.
- Modify `src/bots/gateway.ts`
  - Wire repository/service creation from env.
- Modify `docs/CONFIGURATION.md`
  - Document the read-only repo brain env knobs and expected behavior.

## Task 1: Durable Repo Understanding Cache

**Files:**
- Modify: `src/database/schema.ts`
- Modify: `src/database/types.ts`
- Create: `src/database/repositories/supervisorRepoUnderstandingRepository.ts`
- Modify: `src/database/repositories/index.ts`
- Modify: `src/database/index.test.ts`

- [ ] **Step 1: Write failing schema and repository tests**

Add imports in `src/database/index.test.ts`:

```ts
import {
  SupervisorRepoUnderstandingRepository,
} from './index';
```

Extend the schema test:

```ts
expect(tableNames).toContain('supervisor_repo_understandings');
```

Add a repository test:

```ts
describe('SupervisorRepoUnderstandingRepository', () => {
  test('stores and replaces repo understanding snapshots by repo and commit', () => {
    const repository = new SupervisorRepoUnderstandingRepository(db);

    repository.upsert({
      id: 'understanding-1',
      repo_ref: 'acme/demo-app',
      local_path: '/tmp/demo-app',
      commit_sha: 'abc123',
      status: 'ready',
      summary: 'Telegram-first supervisor workspace.',
      understanding_json: {
        project_purpose: 'Coordinate Telegram supervisor work.',
        tech_stack: ['Bun', 'TypeScript'],
        key_paths: ['src/bots/assistant.ts'],
        architecture_notes: ['Bot routes text before sessions.'],
        artifact_opportunities: ['Visual Plan Card polish.'],
        test_commands: ['bun test src/bots/assistant.test.ts'],
        risks: ['Approval boundary must stay visible.'],
      },
      evidence_paths_json: ['src/bots/assistant.ts'],
      generated_by: 'claude_code',
      error: null,
    });

    repository.upsert({
      id: 'understanding-2',
      repo_ref: 'acme/demo-app',
      local_path: '/tmp/demo-app',
      commit_sha: 'abc123',
      status: 'ready',
      summary: 'Updated summary.',
      understanding_json: {
        project_purpose: 'Updated purpose.',
        tech_stack: ['Bun'],
        key_paths: ['src/supervisor/supervisorAgent.ts'],
        architecture_notes: [],
        artifact_opportunities: [],
        test_commands: ['bun test'],
        risks: [],
      },
      evidence_paths_json: ['src/supervisor/supervisorAgent.ts'],
      generated_by: 'claude_code',
      error: null,
    });

    const stored = repository.findByRepoAndCommit('acme/demo-app', 'abc123');
    expect(stored?.id).toBe('understanding-2');
    expect(stored?.summary).toBe('Updated summary.');
    expect(stored?.understanding_json.project_purpose).toBe('Updated purpose.');
  });
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
bun test src/database/index.test.ts -t "SupervisorRepoUnderstandingRepository"
```

Expected: FAIL because the repository export and table do not exist.

- [ ] **Step 3: Add schema and types**

In `src/database/schema.ts`, add:

```ts
export const SUPERVISOR_REPO_UNDERSTANDINGS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_repo_understandings (
    id TEXT PRIMARY KEY,
    repo_ref TEXT NOT NULL,
    local_path TEXT,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    understanding_json TEXT NOT NULL,
    evidence_paths_json TEXT NOT NULL,
    generated_by TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repo_ref, commit_sha)
  );
`;
```

Add this to `initializeSchema` after `SUPERVISOR_MEMORIES_TABLE_SCHEMA`:

```ts
db.exec(SUPERVISOR_REPO_UNDERSTANDINGS_TABLE_SCHEMA);
```

Add this to `dropAllTables` before `supervisor_memories`:

```ts
db.exec('DROP TABLE IF EXISTS supervisor_repo_understandings;');
```

In `src/database/types.ts`, add:

```ts
export interface SupervisorRepoUnderstandingJson {
  project_purpose: string;
  tech_stack: string[];
  key_paths: string[];
  architecture_notes: string[];
  artifact_opportunities: string[];
  test_commands: string[];
  risks: string[];
}

export interface SupervisorRepoUnderstanding {
  id: string;
  repo_ref: string;
  local_path: string | null;
  commit_sha: string;
  status: 'pending' | 'ready' | 'failed';
  summary: string | null;
  understanding_json: SupervisorRepoUnderstandingJson;
  evidence_paths_json: string[];
  generated_by: 'claude_code' | 'fallback';
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSupervisorRepoUnderstanding {
  id: string;
  repo_ref: string;
  local_path?: string | null;
  commit_sha: string;
  status: SupervisorRepoUnderstanding['status'];
  summary?: string | null;
  understanding_json: SupervisorRepoUnderstandingJson;
  evidence_paths_json?: string[];
  generated_by: SupervisorRepoUnderstanding['generated_by'];
  error?: string | null;
}
```

- [ ] **Step 4: Implement the repository**

Create `src/database/repositories/supervisorRepoUnderstandingRepository.ts`:

```ts
import type {
  CreateSupervisorRepoUnderstanding,
  SupervisorRepoUnderstanding,
  SupervisorRepoUnderstandingJson,
} from '../types';
import type { Database } from 'bun:sqlite';

function parseJsonObject(value: unknown): SupervisorRepoUnderstandingJson {
  if (typeof value !== 'string') {
    return {
      project_purpose: '',
      tech_stack: [],
      key_paths: [],
      architecture_notes: [],
      artifact_opportunities: [],
      test_commands: [],
      risks: [],
    };
  }
  try {
    return JSON.parse(value) as SupervisorRepoUnderstandingJson;
  } catch {
    return {
      project_purpose: '',
      tech_stack: [],
      key_paths: [],
      architecture_notes: [],
      artifact_opportunities: [],
      test_commands: [],
      risks: [],
    };
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export class SupervisorRepoUnderstandingRepository {
  constructor(private readonly db: Database) {}

  upsert(input: CreateSupervisorRepoUnderstanding): SupervisorRepoUnderstanding {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO supervisor_repo_understandings (
        id, repo_ref, local_path, commit_sha, status, summary,
        understanding_json, evidence_paths_json, generated_by, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_ref, commit_sha) DO UPDATE SET
        id = excluded.id,
        local_path = excluded.local_path,
        status = excluded.status,
        summary = excluded.summary,
        understanding_json = excluded.understanding_json,
        evidence_paths_json = excluded.evidence_paths_json,
        generated_by = excluded.generated_by,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      input.id,
      input.repo_ref,
      input.local_path ?? null,
      input.commit_sha,
      input.status,
      input.summary ?? null,
      JSON.stringify(input.understanding_json),
      JSON.stringify(input.evidence_paths_json ?? []),
      input.generated_by,
      input.error ?? null,
      now,
      now,
    );
    return this.findByRepoAndCommit(input.repo_ref, input.commit_sha)!;
  }

  findByRepoAndCommit(repoRef: string, commitSha: string): SupervisorRepoUnderstanding | null {
    const row = this.db
      .prepare('SELECT * FROM supervisor_repo_understandings WHERE repo_ref = ? AND commit_sha = ?')
      .get(repoRef, commitSha) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  findLatestReadyByRepo(repoRef: string): SupervisorRepoUnderstanding | null {
    const row = this.db
      .prepare(`
        SELECT * FROM supervisor_repo_understandings
        WHERE repo_ref = ? AND status = 'ready'
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(repoRef) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  private map(row: Record<string, unknown> | undefined): SupervisorRepoUnderstanding | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      repo_ref: String(row.repo_ref),
      local_path: typeof row.local_path === 'string' ? row.local_path : null,
      commit_sha: String(row.commit_sha),
      status: row.status === 'failed' ? 'failed' : row.status === 'pending' ? 'pending' : 'ready',
      summary: typeof row.summary === 'string' ? row.summary : null,
      understanding_json: parseJsonObject(row.understanding_json),
      evidence_paths_json: parseStringArray(row.evidence_paths_json),
      generated_by: row.generated_by === 'fallback' ? 'fallback' : 'claude_code',
      error: typeof row.error === 'string' ? row.error : null,
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
```

Export it from `src/database/repositories/index.ts`:

```ts
export { SupervisorRepoUnderstandingRepository } from './supervisorRepoUnderstandingRepository';
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
bun test src/database/index.test.ts -t "SupervisorRepoUnderstandingRepository|database schema"
```

Expected: PASS.

## Task 2: Read-Only Claude Code Repo Understanding Service

**Files:**
- Create: `src/supervisor/repoUnderstanding.ts`
- Create: `src/supervisor/claudeRepoUnderstandingService.ts`
- Create: `src/supervisor/claudeRepoUnderstandingService.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `src/supervisor/claudeRepoUnderstandingService.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { DefaultClaudeRepoUnderstandingService } from './claudeRepoUnderstandingService';

describe('DefaultClaudeRepoUnderstandingService', () => {
  test('uses cached ready understanding for the same repo commit', async () => {
    let runnerCalls = 0;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => ({
        repo_ref: 'acme/demo-app',
        commit_sha: 'abc123',
        summary: 'Cached repo understanding.',
        understanding: {
          project_purpose: 'Cached purpose.',
          tech_stack: ['Bun'],
          key_paths: ['src/bots/assistant.ts'],
          architecture_notes: [],
          artifact_opportunities: ['Improve Plan Card visuals.'],
          test_commands: ['bun test'],
          risks: [],
        },
        evidence_paths: ['src/bots/assistant.ts'],
        source: 'cache',
      }),
      save: async () => undefined,
      runClaude: async () => {
        runnerCalls += 1;
        return '{}';
      },
      resolveCommit: async () => 'abc123',
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: false,
    });

    expect(result.summary).toBe('Cached repo understanding.');
    expect(runnerCalls).toBe(0);
  });

  test('builds a read-only prompt and normalizes Claude JSON output', async () => {
    let prompt = '';
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => undefined,
      resolveCommit: async () => 'abc123',
      runClaude: async (input) => {
        prompt = input.prompt;
        return JSON.stringify({
          summary: 'Repo coordinates Telegram supervisor work.',
          project_purpose: 'Turns Telegram conversations into supervised repo work.',
          tech_stack: ['Bun', 'TypeScript'],
          key_paths: ['src/bots/assistant.ts', 'src/supervisor/sessionService.ts'],
          architecture_notes: ['Supervisor controls approval; dev agent mutates code later.'],
          artifact_opportunities: ['Visual issue card improvements.'],
          test_commands: ['bun test src/bots/assistant.test.ts'],
          risks: ['Do not create issues before approval.'],
          evidence_paths: ['src/bots/assistant.ts'],
        });
      },
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('Return JSON only');
    expect(result.commit_sha).toBe('abc123');
    expect(result.understanding.key_paths).toContain('src/bots/assistant.ts');
    expect(result.evidence_paths).toContain('src/bots/assistant.ts');
  });
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
bun test src/supervisor/claudeRepoUnderstandingService.test.ts
```

Expected: FAIL because the service files do not exist.

- [ ] **Step 3: Add types and normalization**

Create `src/supervisor/repoUnderstanding.ts`:

```ts
export interface SupervisorRepoUnderstandingData {
  project_purpose: string;
  tech_stack: string[];
  key_paths: string[];
  architecture_notes: string[];
  artifact_opportunities: string[];
  test_commands: string[];
  risks: string[];
}

export interface SupervisorRepoUnderstandingSnapshot {
  repo_ref: string;
  commit_sha: string;
  summary: string;
  understanding: SupervisorRepoUnderstandingData;
  evidence_paths: string[];
  source: 'cache' | 'claude_code' | 'fallback';
}

export interface SupervisorRepoUnderstandingInput {
  repoRef: string;
  localPath: string | null;
  forceRefresh?: boolean;
}

export interface SupervisorRepoUnderstandingService {
  understand(input: SupervisorRepoUnderstandingInput): Promise<SupervisorRepoUnderstandingSnapshot>;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, 12);
}

export function normalizeRepoUnderstandingRecord(
  value: Record<string, unknown>,
): Pick<SupervisorRepoUnderstandingSnapshot, 'summary' | 'understanding' | 'evidence_paths'> {
  const summary = typeof value.summary === 'string' && value.summary.trim()
    ? value.summary.trim()
    : 'Repository understanding is available, but the summary was sparse.';
  return {
    summary,
    understanding: {
      project_purpose: typeof value.project_purpose === 'string' ? value.project_purpose.trim() : summary,
      tech_stack: normalizeStringArray(value.tech_stack),
      key_paths: normalizeStringArray(value.key_paths),
      architecture_notes: normalizeStringArray(value.architecture_notes),
      artifact_opportunities: normalizeStringArray(value.artifact_opportunities),
      test_commands: normalizeStringArray(value.test_commands),
      risks: normalizeStringArray(value.risks),
    },
    evidence_paths: normalizeStringArray(value.evidence_paths),
  };
}
```

- [ ] **Step 4: Implement the service**

Create `src/supervisor/claudeRepoUnderstandingService.ts`:

```ts
import * as cp from 'child_process';
import { promisify } from 'util';
import {
  normalizeRepoUnderstandingRecord,
  type SupervisorRepoUnderstandingInput,
  type SupervisorRepoUnderstandingService,
  type SupervisorRepoUnderstandingSnapshot,
} from './repoUnderstanding';

const execFile = promisify(cp.execFile);

export interface ClaudeRepoUnderstandingRunnerInput {
  localPath: string;
  prompt: string;
}

export interface DefaultClaudeRepoUnderstandingServiceOptions {
  findCached(input: { repoRef: string; commitSha: string }): Promise<SupervisorRepoUnderstandingSnapshot | null>;
  save(snapshot: SupervisorRepoUnderstandingSnapshot & { localPath: string | null }): Promise<void>;
  resolveCommit(localPath: string): Promise<string>;
  runClaude(input: ClaudeRepoUnderstandingRunnerInput): Promise<string>;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function buildRepoUnderstandingPrompt(repoRef: string): string {
  return [
    'READ-ONLY repository understanding task.',
    'Do not edit files, create commits, create issues, run destructive commands, or change repository state.',
    'Use fast file discovery such as rg and package/readme/config inspection.',
    'Understand enough to advise a Telegram supervisor about programming questions, artifact creation, and safe implementation planning.',
    'Return JSON only with this shape:',
    '{"summary":"...","project_purpose":"...","tech_stack":["..."],"key_paths":["..."],"architecture_notes":["..."],"artifact_opportunities":["..."],"test_commands":["..."],"risks":["..."],"evidence_paths":["..."]}',
    `repo_ref: ${repoRef}`,
  ].join('\n');
}

export class DefaultClaudeRepoUnderstandingService implements SupervisorRepoUnderstandingService {
  constructor(private readonly options: DefaultClaudeRepoUnderstandingServiceOptions) {}

  async understand(input: SupervisorRepoUnderstandingInput): Promise<SupervisorRepoUnderstandingSnapshot> {
    if (!input.localPath) {
      return {
        repo_ref: input.repoRef,
        commit_sha: 'unknown',
        summary: 'No local repository path is configured yet.',
        understanding: {
          project_purpose: 'Unknown until a local path is configured.',
          tech_stack: [],
          key_paths: [],
          architecture_notes: [],
          artifact_opportunities: [],
          test_commands: [],
          risks: ['Missing local_path prevents Claude Code repo understanding.'],
        },
        evidence_paths: [],
        source: 'fallback',
      };
    }

    const commitSha = await this.options.resolveCommit(input.localPath);
    if (!input.forceRefresh) {
      const cached = await this.options.findCached({ repoRef: input.repoRef, commitSha });
      if (cached) return cached;
    }

    const raw = await this.options.runClaude({
      localPath: input.localPath,
      prompt: buildRepoUnderstandingPrompt(input.repoRef),
    });
    const parsed = extractJsonObject(raw);
    const normalized = normalizeRepoUnderstandingRecord(parsed ?? {});
    const snapshot: SupervisorRepoUnderstandingSnapshot = {
      repo_ref: input.repoRef,
      commit_sha: commitSha,
      summary: normalized.summary,
      understanding: normalized.understanding,
      evidence_paths: normalized.evidence_paths,
      source: 'claude_code',
    };
    await this.options.save({ ...snapshot, localPath: input.localPath });
    return snapshot;
  }
}

export async function resolveGitCommit(localPath: string): Promise<string> {
  const { stdout } = await execFile('git', ['-C', localPath, 'rev-parse', 'HEAD']);
  return stdout.trim() || 'unknown';
}
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
bun test src/supervisor/claudeRepoUnderstandingService.test.ts
```

Expected: PASS.

## Task 3: Runtime Context Includes Cached Repo Understanding

**Files:**
- Modify: `src/bots/types.ts`
- Modify: `src/bots/assistant.ts`
- Modify: `src/bots/runtimeContext.ts`
- Modify: `src/bots/runtimeContext.test.ts`
- Modify: `src/bots/gateway.ts`

- [ ] **Step 1: Write failing runtime context test**

In `src/bots/runtimeContext.test.ts`, add a test that constructs `BotRuntimeContextService` with an injected repo understanding service:

```ts
test('includes cached repo understanding for the default project when available', async () => {
  const context = await service.buildContext(
    {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-1' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    },
    '这个仓库适合做什么 artifact？',
    defaultDiagnostics,
  );

  expect(context.repo_understanding?.repo_ref).toBe('UniUni2000/test2');
  expect(context.repo_understanding?.understanding.artifact_opportunities).toContain('Visual Plan Card');
});
```

Use this injected service in the test setup:

```ts
const repoUnderstandingService = {
  understand: async () => ({
    repo_ref: 'UniUni2000/test2',
    commit_sha: 'abc123',
    summary: 'Repo understands Telegram supervisor work.',
    understanding: {
      project_purpose: 'Telegram supervisor control plane.',
      tech_stack: ['Bun', 'TypeScript'],
      key_paths: ['src/bots/assistant.ts'],
      architecture_notes: ['Assistant routes text to supervisor.'],
      artifact_opportunities: ['Visual Plan Card'],
      test_commands: ['bun test'],
      risks: ['Approval boundary'],
    },
    evidence_paths: ['src/bots/assistant.ts'],
    source: 'cache',
  }),
};
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test src/bots/runtimeContext.test.ts -t "repo understanding"
```

Expected: FAIL because `repo_understanding` is not in context.

- [ ] **Step 3: Add the context type**

In `src/bots/types.ts`, import or duplicate a serializable view type:

```ts
export interface BotRepoUnderstandingView {
  repo_ref: string;
  commit_sha: string;
  summary: string;
  understanding: {
    project_purpose: string;
    tech_stack: string[];
    key_paths: string[];
    architecture_notes: string[];
    artifact_opportunities: string[];
    test_commands: string[];
    risks: string[];
  };
  evidence_paths: string[];
  source: 'cache' | 'claude_code' | 'fallback';
}
```

Add to `BotRuntimeCopilotContext`:

```ts
repo_understanding: BotRepoUnderstandingView | null;
```

- [ ] **Step 4: Load repo understanding in runtime context**

Modify `BotRuntimeContextService` constructor in `src/bots/runtimeContext.ts`:

```ts
private readonly repoUnderstandingService: SupervisorRepoUnderstandingService | null = null,
```

After `repoProfile` resolution, add:

```ts
const repoUnderstanding = repoProfileRoute && this.repoUnderstandingService
  ? await this.repoUnderstandingService.understand({
      repoRef: repoProfileRoute.github_repo_full,
      localPath: repoProfileRoute.local_path ?? null,
      forceRefresh: false,
    }).catch(() => null)
  : null;
```

Return:

```ts
repo_understanding: repoUnderstanding,
```

- [ ] **Step 5: Pass the service through assistant construction**

In `src/bots/assistant.ts`, add a nullable constructor parameter:

```ts
import type { SupervisorRepoUnderstandingService } from '../supervisor/repoUnderstanding';

private readonly repoUnderstandingService: SupervisorRepoUnderstandingService | null = null,
```

Pass it into `BotRuntimeContextService`:

```ts
this.runtimeContext = new BotRuntimeContextService(
  runtime,
  preferences,
  projectResolver,
  subscriptions,
  followupMessageStates,
  undefined,
  this.repoUnderstandingService,
);
```

Keep the default `null` so existing tests that construct `BotAssistantService` do not need to change.

- [ ] **Step 6: Wire from gateway**

In `src/bots/gateway.ts`, instantiate the service only when `db` and a repository are available:

```ts
const supervisorRepoUnderstandingRepository = db
  ? new SupervisorRepoUnderstandingRepository(db)
  : null;
```

Create an adapter object that maps repository rows to `SupervisorRepoUnderstandingSnapshot` and uses `resolveGitCommit`. Inject it into `BotAssistantService` through `BotRuntimeContextService` construction. Keep the default null path for tests that do not need it.

- [ ] **Step 7: Run focused tests**

Run:

```bash
bun test src/bots/runtimeContext.test.ts -t "repo understanding"
```

Expected: PASS.

## Task 4: Supervisor Agent Uses Repo Understanding And Artifact Ideation

**Files:**
- Modify: `src/supervisor/supervisorAgent.ts`
- Modify: `src/supervisor/supervisorAgent.test.ts`

- [ ] **Step 1: Write failing supervisor agent tests**

Add to `src/supervisor/supervisorAgent.test.ts`:

```ts
test('includes deep repo understanding in the supervisor prompt', async () => {
  let prompt = '';
  const agent = new DefaultSupervisorAgentService({
    resolveRepoProfile: async () => repoProfile,
    resolveRepoUnderstanding: async () => ({
      repo_ref: 'acme/demo-app',
      commit_sha: 'abc123',
      summary: 'Deep repo summary.',
      understanding: {
        project_purpose: 'Turns Telegram requests into supervised repo execution.',
        tech_stack: ['Bun', 'TypeScript'],
        key_paths: ['src/supervisor/sessionService.ts'],
        architecture_notes: ['SessionService owns approval gates.'],
        artifact_opportunities: ['Generate visual Telegram issue cards.'],
        test_commands: ['bun test src/supervisor/sessionService.test.ts'],
        risks: ['Never materialize before approval.'],
      },
      evidence_paths: ['src/supervisor/sessionService.ts'],
      source: 'claude_code',
    }),
    analyze: async (input) => {
      prompt = input.prompt;
      return {
        mode: 'artifact_ideation',
        title: 'Visual Telegram issue card',
        recommendation: 'Use the existing session visual card surface.',
        rationale: 'The repo already has session visual card rendering.',
        next_step: 'Offer a Plan Card before implementation.',
      };
    },
  });

  const result = await agent.respond({
    localPath: '/tmp/demo-app',
    repoRef: 'acme/demo-app',
    defaultRepoRef: null,
    userText: '我想创建一个更抓眼球的 Telegram artifact',
    projectContext: null,
    runtimeContext: {
      source: 'telegram_chat',
      defaultProjectSlug: 'demo-app',
      activeIssueId: null,
    },
  });

  expect(prompt).toContain('repo_understanding');
  expect(prompt).toContain('Generate visual Telegram issue cards');
  expect(result?.mode).toBe('artifact_ideation');
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test src/supervisor/supervisorAgent.test.ts -t "deep repo understanding|artifact"
```

Expected: FAIL because `resolveRepoUnderstanding` and `artifact_ideation` do not exist.

- [ ] **Step 3: Extend result types**

In `src/supervisor/supervisorAgent.ts`, add:

```ts
import type {
  SupervisorRepoUnderstandingService,
  SupervisorRepoUnderstandingSnapshot,
} from './repoUnderstanding';
```

Add `repoUnderstanding` to normalized input and options:

```ts
repoUnderstanding: SupervisorRepoUnderstandingSnapshot | null;
resolveRepoUnderstanding?: SupervisorRepoUnderstandingService['understand'];
```

Add result mode:

```ts
| {
    mode: 'artifact_ideation';
    repoRef: string | null;
    title: string;
    recommendation: string;
    rationale: string;
    nextStep: string;
  }
```

- [ ] **Step 4: Add prompt rules**

Update `buildPrompt` to include:

```ts
'When the user asks to create art, UI, visual cards, demos, pages, or artifacts, use repo_understanding to recommend one concrete artifact path before creating work.',
'Allowed modes: chat_reply, repo_answer, artifact_ideation, issue_recommendation, handoff_to_session, clarify.',
`repo_understanding: ${JSON.stringify(input.repoUnderstanding)}`,
```

- [ ] **Step 5: Parse artifact ideation**

In `parseResult`, add:

```ts
if (record.mode === 'artifact_ideation') {
  const title = nonBlankString(record.title);
  const recommendation = nonBlankString(record.recommendation);
  const rationale = nonBlankString(record.rationale);
  const nextStep = nonBlankString(record.next_step ?? record.nextStep);
  if (!title || !recommendation || !rationale || !nextStep) return null;
  return { mode: 'artifact_ideation', repoRef, title, recommendation, rationale, nextStep };
}
```

- [ ] **Step 6: Resolve understanding in `respond`**

After resolving `repoProfile`, add:

```ts
const repoUnderstanding = resolvedRepoRef && this.options.resolveRepoUnderstanding
  ? await this.options.resolveRepoUnderstanding({
      repoRef: resolvedRepoRef,
      localPath: input.localPath,
      forceRefresh: false,
    }).catch(() => null)
  : null;
```

Include `repoUnderstanding` in the normalized input and prompt.

- [ ] **Step 7: Run focused tests**

Run:

```bash
bun test src/supervisor/supervisorAgent.test.ts
```

Expected: PASS.

## Task 5: Assistant Maps Artifact Ideation Into Existing Plan Card Flow

**Files:**
- Modify: `src/bots/assistant.ts`
- Modify: `src/bots/assistant.test.ts`

- [ ] **Step 1: Write failing assistant test**

Add to `src/bots/assistant.test.ts`:

```ts
test('turns artifact ideation into a repo-aware recommendation card without immediate materialization', async () => {
  const agent: SupervisorAgentService = {
    respond: async () => ({
      mode: 'artifact_ideation',
      repoRef: 'UniUni2000/test2',
      title: 'Telegram visual issue card',
      recommendation: 'Use the existing SVG-backed session visual card path.',
      rationale: 'The repo already renders visual cards and Telegram sends them as photos.',
      nextStep: 'Show a Plan Card before implementation.',
    }),
  };

  const response = await assistant.respondToText(context, '我想创建一个更抓眼球的 Telegram artifact');

  expect(response.message).toContain('计划待你批准');
  expect(response.message).toContain('Telegram visual issue card');
  expect(runtime.createIssueCalls).toHaveLength(0);
});
```

Use the existing test setup style from the `routes supervisor agent handoff results through the existing supervisor session flow` test.

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test src/bots/assistant.test.ts -t "artifact ideation"
```

Expected: FAIL because the assistant does not map artifact ideation yet.

- [ ] **Step 3: Add artifact intent conversion**

In `src/bots/assistant.ts`, add a converter near `toSupervisorAgentIssueIntent`:

```ts
function toSupervisorAgentArtifactIntent(
  result: Extract<SupervisorAgentResult, { mode: 'artifact_ideation' }>,
  runtimeContext: BotRuntimeCopilotContext,
): BotAssistantIntent {
  return {
    kind: 'create_issue',
    title: result.title,
    description: [
      result.recommendation,
      '',
      `Rationale: ${result.rationale}`,
      `Next step: ${result.nextStep}`,
    ].join('\n'),
    project_slug: runtimeContext.default_project_slug,
  };
}
```

In `respondFromSupervisorAgentResult`, handle:

```ts
case 'artifact_ideation': {
  if (!this.supervisorSessionService) {
    return {
      message: [
        result.recommendation,
        '',
        result.rationale,
      ].join('\n'),
    };
  }
  return this.supervisorSessionService.respond({
    context: params.context,
    text: params.text,
    intent: toSupervisorAgentArtifactIntent(params.agentResult, params.runtimeContext),
    runtimeContext: params.runtimeContext,
    canWrite: this.canWrite(params.context),
    source: 'telegram_chat',
  });
}
```

- [ ] **Step 4: Run focused assistant tests**

Run:

```bash
bun test src/bots/assistant.test.ts -t "artifact ideation|supervisor agent handoff|ordinary Telegram natural chat"
```

Expected: PASS.

## Task 6: Real Claude Code Runner Adapter For Understanding

**Files:**
- Modify: `src/supervisor/claudeRepoUnderstandingService.ts`
- Modify: `src/bots/gateway.ts`
- Create: `src/supervisor/claudeRepoUnderstandingService.integration.test.ts`

- [ ] **Step 1: Add a skipped-by-default integration test**

Create `src/supervisor/claudeRepoUnderstandingService.integration.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createClaudeCodeRepoUnderstandingRunner } from './claudeRepoUnderstandingService';

describe('createClaudeCodeRepoUnderstandingRunner', () => {
  test.skipIf(process.env.SYMPHONY_RUN_CLAUDE_REPO_UNDERSTANDING_IT !== '1')(
    'runs the bundled Claude Code path in read-only understanding mode',
    async () => {
      const runClaude = createClaudeCodeRepoUnderstandingRunner({
        command: process.env.SYMPHONY_CLAUDE_REPO_UNDERSTANDING_COMMAND
          ?? 'node scripts/claude-adapter.cjs',
        timeoutMs: 120_000,
      });
      const output = await runClaude({
        localPath: process.cwd(),
        prompt: 'READ-ONLY. Return JSON only: {"summary":"ok","project_purpose":"ok","tech_stack":[],"key_paths":[],"architecture_notes":[],"artifact_opportunities":[],"test_commands":[],"risks":[],"evidence_paths":[]}',
      });
      expect(output).toContain('{');
    },
  );
});
```

- [ ] **Step 2: Implement the runner factory**

In `src/supervisor/claudeRepoUnderstandingService.ts`, add:

```ts
export function createClaudeCodeRepoUnderstandingRunner(config: {
  command: string;
  timeoutMs: number;
}): (input: ClaudeRepoUnderstandingRunnerInput) => Promise<string> {
  return async (input) => {
    const [binary, ...rest] = config.command.split(/\s+/).filter(Boolean);
    if (!binary) {
      throw new Error('Missing Claude repo understanding command.');
    }
    const { stdout } = await execFile(
      binary,
      [...rest, '--prompt', input.prompt],
      {
        cwd: input.localPath,
        timeout: config.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return stdout;
  };
}
```

- [ ] **Step 3: Wire env defaults in gateway**

In `src/bots/gateway.ts`, create the repo understanding service with:

```ts
const repoUnderstandingTimeoutMs = Number.parseInt(
  process.env.SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS || '120000',
  10,
);
```

Use:

```ts
createClaudeCodeRepoUnderstandingRunner({
  command: process.env.SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND
    || 'node scripts/claude-adapter.cjs',
  timeoutMs: Number.isFinite(repoUnderstandingTimeoutMs) ? repoUnderstandingTimeoutMs : 120_000,
})
```

Do not run this on every request if a matching cache row exists.

- [ ] **Step 4: Run non-integration tests**

Run:

```bash
bun test src/supervisor/claudeRepoUnderstandingService.test.ts src/bots/gateway.test.ts
```

Expected: PASS. The integration test remains skipped unless env is enabled.

## Task 7: Docs And Verification

**Files:**
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/AI_OPERATOR_GUIDE.md`

- [ ] **Step 1: Document configuration**

Add to `docs/CONFIGURATION.md`:

```md
### Supervisor repo understanding

The Telegram supervisor can use the bundled Claude Code runtime in read-only mode to understand a configured repository before answering repo questions or recommending artifact work.

| Variable | Required | Description |
| --- | --- | --- |
| `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | optional | Command used for read-only repo understanding. Defaults to `node scripts/claude-adapter.cjs`. |
| `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | optional | Timeout for a read-only repo-understanding run. Defaults to `120000`. |

The understanding layer must not edit files, create issues, or dispatch work. It only returns structured repository context. Code changes still happen later through the approved supervisor session and dev-agent execution path.
```

- [ ] **Step 2: Document operator troubleshooting**

Add to `docs/AI_OPERATOR_GUIDE.md` under Supervisor/Telegram troubleshooting:

```md
### Supervisor answers feel shallow

Check whether the repo understanding cache exists for the configured repo and current commit. If it is missing or failed, verify:

- the chat has a default project
- the project route has `local_path`
- `git -C <local_path> rev-parse HEAD` works
- `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` can start
- the command returns JSON rather than prose
```

- [ ] **Step 3: Run focused verification**

Run:

```bash
bun test src/database/index.test.ts src/supervisor/supervisorAgent.test.ts src/supervisor/claudeRepoUnderstandingService.test.ts src/bots/runtimeContext.test.ts src/bots/assistant.test.ts
bun run build
git diff --check
```

Expected: all commands PASS.

## Final Review Checklist

- [ ] Normal Telegram chat still returns a conversational answer without creating an issue.
- [ ] Repo questions can use Claude Code generated repo understanding when cached or freshly available.
- [ ] Artifact/creative requests produce a repo-aware recommendation and Plan Card.
- [ ] Approval is required before materialization.
- [ ] Claude Code repo understanding prompt explicitly forbids mutation.
- [ ] Failed repo understanding degrades to shallow profile/fallback instead of breaking Telegram chat.
- [ ] Existing Plan Card and visual issue card behavior remains intact.

## Subagent Task Order

1. Task 1: database/cache foundation.
2. Task 2: read-only repo understanding service.
3. Task 3: runtime context wiring.
4. Task 4: supervisor agent prompt/result upgrade.
5. Task 5: assistant artifact-to-Plan-Card mapping.
6. Task 6: real runner env wiring.
7. Task 7: docs and verification.

Use subagent-driven-development review gates after every task before moving to the next one.
