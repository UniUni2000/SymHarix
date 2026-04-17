# Symphony MVP Redesign - Dynamic GitHub Repo Mapping

> **Goal:** Simplify configuration by auto-detecting GitHub repos from Linear Project names, eliminating need for explicit `GITHUB_REPO` in `.env`.

---

## 1. Overview

**Current Problem:**
- `.env` requires explicit `GITHUB_REPO=symphony-test` configuration
- `WORKFLOW.md` requires manual `projects` mapping with `github_repo` and `local_path`
- Inflexible - can't easily add new Linear Projects

**New Approach:**
- Linear Project name → GitHub Repo name (auto-mapped)
- No explicit repo configuration needed
- Multi-project support out of the box

---

## 2. Architecture

```
User runs symphony
       ↓
Orchestrator starts
       ↓
Fetch all Linear Projects via GraphQL
       ↓
For each Project (e.g., "symphony-test"):
  - Build GitHub repo name: "UniUni2000/symphony-test"
  - Check if repo exists via GitHub API
    - Not found → Auto-create as private repo
  - Map to local workspace: workspaces/symphony-test/
       ↓
Poll for active issues (Todo, In Progress, In Review)
       ↓
For each issue:
  1. Get Linear Project name from issue.project.name
  2. Derive GitHub repo: owner/project-name
  3. Check/create GitHub repo
  4. Create git worktree: workspaces/{project}/{issue-id}/
  5. Create feature branch: feat/{issue-id}-{slug}
  6. Trigger DEV/REVIEW agent
```

---

## 3. Data Flow

### 3.1 Linear Issue Structure
```typescript
interface LinearIssue {
  identifier: "INT-23"
  title: "写一个 hello world 的 Python 脚本"
  project: {
    name: "symphony-test"    // → Used for GitHub repo name
    slugId: "6d0843db8904"     // → Used for API queries
  }
  state: { name: "In Progress" }
  branchName: "feat/INT-23-hello-world"
}
```

### 3.2 GitHub Repo Resolution
```
Linear Project.name = "symphony-test"
     ↓
GitHub Repo Name = "symphony-test"
GitHub Full Name = "UniUni2000/symphony-test"  (GITHUB_OWNER from .env)
     ↓
GitHub API: GET /repos/UniUni2000/symphony-test
     ↓
Found? → Use existing
Not Found? → POST /user/repos (create private repo)
```

### 3.3 Local Workspace Structure
```
workspaces/
├── symphony-test/          # Project name from Linear
│   ├── INT-23/             # Issue worktree
│   │   ├── (code files)
│   │   └── .git
│   ├── INT-24/
│   └── ...
├── another-project/
│   └── ...
```

---

## 4. Configuration

### 4.1 .env (Simplified)
```bash
# Linear
SYMPHONY_TRACKER_API_KEY=lin_api_xxx
SYMPHONY_TRACKER_PROJECT_SLUG=xxx  # Team/project slug for initial query

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_OWNER=UniUni2000            # All repos under this owner
# GITHUB_REPO removed - no longer needed

# Workspace
SYMPHONY_WORKSPACE_ROOT=/path/to/workspaces
```

### 4.2 WORKFLOW.md (Simplified)
```yaml
---
tracker:
  kind: linear
  api_key: $SYMPHONY_TRACKER_API_KEY
  endpoint: https://api.linear.app/graphql
  # projects config removed - auto-discovered

active_states:
  - Todo
  - In Progress
  - In Review
  - Cancelled

terminal_states:
  - Done
  - Canceled
  - Duplicate

polling:
  interval_ms: 30000

workspace:
  root: /path/to/workspaces

hooks:
  before_run: ./scripts/before-run.sh
  after_run: ./scripts/after-run.sh
  timeout_ms: 120000

codex:
  command: node ./scripts/claude-adapter.cjs

agent:
  max_concurrent_agents: 3
```

---

## 5. API Changes

### 5.1 Linear API - Fetch Projects
```graphql
query GetProjects($teamSlug: String!) {
  team(slug: $teamSlug) {
    name
    projects {
      nodes {
        name      # Used for GitHub repo name
        slugId    # Used for issue queries
      }
    }
  }
}
```

### 5.2 Linear API - Fetch Issues
```graphql
query GetIssues($projectSlugIds: [String!]) {
  issues(filter: {
    project: { slugId: { in: $projectSlugIds } }
    state: { name: { in: ["Todo", "In Progress", "In Review"] } }
  }) {
    nodes {
      id
      identifier
      title
      project {
        name      # Extract for GitHub mapping
        slugId
      }
      state { name }
      branchName
    }
  }
}
```

### 5.3 GitHub API - Check Repo
```http
GET /repos/{owner}/{repo}
```

### 5.4 GitHub API - Create Repo
```http
POST /user/repos
{
  "name": "symphony-test",
  "private": true,
  "auto_init": false
}
```

---

## 6. Implementation Notes

### 6.1 Repo Existence Check
- Always query GitHub API dynamically (no caching)
- Fast operation (~100ms), acceptable for typical issue volume

### 6.2 Multi-Project Support
- All projects under the configured Linear team are discovered
- Each project maps to a GitHub repo of the same name
- Workspaces organized as: workspaces/{project-name}/{issue-id}/

### 6.3 Default Branch
- New repos created with `main` as default branch
- Existing repos use their configured default branch

### 6.4 Git Operations
- Issues get dedicated worktrees
- Feature branches created from default branch
- Branch naming: `feat/{issue-id}-{slug}` (e.g., `feat/INT-23-add-hello-world`)

---

## 7. Out of Scope (v1)

- GitHub App / OAuth for multi-owner scenarios
- Custom repo name mapping (Linear name ≠ GitHub name)
- Repo initialization templates
- Manual repo mapping override
