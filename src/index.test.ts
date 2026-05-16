/**
 * SymHarix Core Tests
 * Section 17: Test and Validation Matrix
 */

import { describe, it, expect } from '@jest/globals';
import { loadWorkflow, parseWorkflowContent, resolveWorkflowPath } from './workflow/loader';
import { buildServiceConfig, validateConfigForDispatch } from './config/loader';
import { sanitizeWorkspaceKey } from './workspace/manager';
import { judgeComplexity } from './hooks/dev-prompt';

describe('Workflow Loader', () => {
  describe('parseWorkflowContent', () => {
    it('should parse workflow with YAML front matter', () => {
      const content = `---
tracker:
  kind: linear
  api_key: test_key
  project_slug: TEST
---

This is the prompt body.
`;
      const result = parseWorkflowContent(content);
      expect(result.success).toBe(true);
      const tracker = result.definition?.config.tracker as Record<string, unknown>;
      expect(tracker.kind).toBe('linear');
      expect(result.definition?.prompt_template).toBe('This is the prompt body.');
    });

    it('should parse workflow without front matter', () => {
      const content = 'This is the entire prompt.';
      const result = parseWorkflowContent(content);
      expect(result.success).toBe(true);
      expect(result.definition?.config).toEqual({});
      expect(result.definition?.prompt_template).toBe('This is the entire prompt.');
    });

    it('should fail on non-map YAML front matter', () => {
      const content = `---
- list item 1
- list item 2
---

Prompt body.
`;
      const result = parseWorkflowContent(content);
      expect(result.success).toBe(false);
      expect(result.error).toBe('workflow_front_matter_not_a_map');
    });

    it('should fail on missing closing ---', () => {
      const content = `---
tracker:
  kind: linear
`;
      const result = parseWorkflowContent(content);
      expect(result.success).toBe(false);
      expect(result.error).toBe('workflow_parse_error');
    });
  });

  describe('loadWorkflow', () => {
    it('should explain how to create a local workflow file from the example when WORKFLOW.md is missing', () => {
      const result = loadWorkflow('__missing__/WORKFLOW.md');
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_workflow_file');
      expect(result.errorMessage).toContain('WORKFLOW.md.example');
      expect(result.errorMessage).toContain('WORKFLOW.md');
    });
  });
});

describe('Config Layer', () => {
  describe('buildServiceConfig', () => {
    it('should apply defaults when values are missing', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          }
        },
        prompt_template: 'test'
      };
      const config = buildServiceConfig(workflow);
      expect(config.pollIntervalMs).toBe(30000);
      expect(config.maxConcurrentAgents).toBe(10);
      expect(config.activeStates).toEqual(['Todo', 'In Progress', 'In Review']);
    });

    it('should resolve $VAR environment references', () => {
      process.env.TEST_API_KEY = 'resolved_value';
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: '$TEST_API_KEY',
            project_slug: 'TEST'
          }
        },
        prompt_template: 'test'
      };
      const config = buildServiceConfig(workflow);
      expect(config.trackerApiKey).toBe('resolved_value');
      delete process.env.TEST_API_KEY;
    });

    it('should resolve SYMHARIX $VAR references from legacy SYMPHONY env aliases', () => {
      const previousCurrent = process.env.SYMHARIX_TRACKER_API_KEY;
      const previousLegacy = process.env.SYMPHONY_TRACKER_API_KEY;
      delete process.env.SYMHARIX_TRACKER_API_KEY;
      process.env.SYMPHONY_TRACKER_API_KEY = 'legacy_value';
      try {
        const workflow = {
          config: {
            tracker: {
              kind: 'linear',
              api_key: '$SYMHARIX_TRACKER_API_KEY',
              project_slug: 'TEST'
            }
          },
          prompt_template: 'test'
        };
        const config = buildServiceConfig(workflow);
        expect(config.trackerApiKey).toBe('legacy_value');
      } finally {
        if (previousCurrent === undefined) {
          delete process.env.SYMHARIX_TRACKER_API_KEY;
        } else {
          process.env.SYMHARIX_TRACKER_API_KEY = previousCurrent;
        }
        if (previousLegacy === undefined) {
          delete process.env.SYMPHONY_TRACKER_API_KEY;
        } else {
          process.env.SYMPHONY_TRACKER_API_KEY = previousLegacy;
        }
      }
    });

    it('should prefer agent_runner config while keeping legacy codex config as a fallback', () => {
      const preferredWorkflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          agent_runner: {
            command: 'node ./scripts/claude-adapter.cjs',
            turn_timeout_ms: 1234,
          },
          codex: {
            command: 'legacy-command',
            turn_timeout_ms: 9999,
          },
        },
        prompt_template: 'test'
      };

      const preferredConfig = buildServiceConfig(preferredWorkflow);
      expect(preferredConfig.codexCommand).toBe('node ./scripts/claude-adapter.cjs');
      expect(preferredConfig.codexTurnTimeoutMs).toBe(1234);

      const legacyWorkflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          codex: {
            command: 'legacy-command',
            turn_timeout_ms: 9999,
          },
        },
        prompt_template: 'test'
      };

      const legacyConfig = buildServiceConfig(legacyWorkflow);
      expect(legacyConfig.codexCommand).toBe('legacy-command');
      expect(legacyConfig.codexTurnTimeoutMs).toBe(9999);
    });

    it('should parse repositories.routing into formal repository routes', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          repositories: {
            routing: {
              test: {
                github_owner: 'acme',
                github_repo: 'repo-a',
                local_path: './repos/repo-a',
                require_repo_harness: true,
              },
            },
          },
        },
        prompt_template: 'test'
      };

      const config = buildServiceConfig(workflow);
      expect(config.repositories.routing).toEqual({
        test: {
          github_owner: 'acme',
          github_repo: 'repo-a',
          local_path: expect.stringMatching(/repos\/repo-a$/),
          require_repo_harness: true,
        },
      });
    });

    it('should keep local_path null when omitted', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          repositories: {
            routing: {
              test: {
                github_owner: 'acme',
                github_repo: 'repo-a',
              },
            },
          },
        },
        prompt_template: 'test'
      };

      const config = buildServiceConfig(workflow);
      expect(config.repositories.routing).toEqual({
        test: {
          github_owner: 'acme',
          github_repo: 'repo-a',
          local_path: null,
          require_repo_harness: false,
        },
      });
    });

    it('should parse verification.lifecycle project scenarios keyed by project_slug', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          verification: {
            lifecycle: {
              timeout_ms: 1800000,
              poll_interval_ms: 5000,
              projects: {
                test2: {
                  title: 'Lifecycle smoke test',
                  description: 'Create a tiny change and verify the full lifecycle.',
                },
              },
            },
          },
        },
        prompt_template: 'test'
      };

      const config = buildServiceConfig(workflow);
      expect(config.verification.lifecycle.timeoutMs).toBe(1800000);
      expect(config.verification.lifecycle.pollIntervalMs).toBe(5000);
      expect(config.verification.lifecycle.projects).toEqual({
        test2: {
          title: 'Lifecycle smoke test',
          description: 'Create a tiny change and verify the full lifecycle.',
        },
      });
    });

    it('should only preserve supported workspace hooks and ignore legacy hook keys', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          hooks: {
            timeout_ms: 120000,
            after_create: './scripts/hooks/after_create.sh',
            before_run: './scripts/hooks/before_run.py',
            after_run: './scripts/hooks/after_run.py',
            before_remove: './scripts/hooks/before_remove.py',
          },
        },
        prompt_template: 'test'
      };

      const config = buildServiceConfig(workflow);
      expect(config.hooks).toEqual({
        after_create: './scripts/hooks/after_create.sh',
        timeout_ms: 120000,
      });
    });

    it('should fail fast when verification.lifecycle scenario is missing title or description', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          verification: {
            lifecycle: {
              projects: {
                broken: {
                  title: 'Incomplete scenario',
                },
              },
            },
          },
        },
        prompt_template: 'test'
      };

      expect(() => buildServiceConfig(workflow)).toThrow(
        'Invalid verification.lifecycle.projects entry for "broken": description is required.',
      );
    });

    it('should fail fast on malformed repositories.routing entries', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          },
          repositories: {
            routing: {
              broken: {
                github_owner: 'acme',
              },
            },
          },
        },
        prompt_template: 'test'
      };

      expect(() => buildServiceConfig(workflow)).toThrow(
        'Invalid repositories.routing entry for "broken": github_repo is required.',
      );
    });

    it('should validate required fields for dispatch', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            api_key: 'test',
            project_slug: 'TEST'
          }
        },
        prompt_template: 'test'
      };
      const config = buildServiceConfig(workflow);
      const validation = validateConfigForDispatch(config);
      expect(validation.valid).toBe(true);
    });

    it('should fail validation without api_key', () => {
      const workflow = {
        config: {
          tracker: {
            kind: 'linear',
            project_slug: 'TEST'
          }
        },
        prompt_template: 'test'
      };
      const config = buildServiceConfig(workflow);
      const validation = validateConfigForDispatch(config);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing required "tracker.api_key" (or environment variable not set)');
    });
  });
});

describe('Workspace Manager', () => {
  describe('sanitizeWorkspaceKey', () => {
    it('should preserve valid characters', () => {
      expect(sanitizeWorkspaceKey('ABC-123')).toBe('ABC-123');
      expect(sanitizeWorkspaceKey('test.issue')).toBe('test.issue');
    });

    it('should replace invalid characters with underscore', () => {
      expect(sanitizeWorkspaceKey('ABC 123')).toBe('ABC_123');
      expect(sanitizeWorkspaceKey('test/issue')).toBe('test_issue');
      expect(sanitizeWorkspaceKey('issue#42')).toBe('issue_42');
    });

    it('should handle unicode characters', () => {
      expect(sanitizeWorkspaceKey('测试 -123')).toBe('___-123');
    });
  });
});

describe('Issue Sorting', () => {
  // These tests would require importing the orchestrator
  // and testing the sortForDispatch method
  it('placeholder for orchestrator tests', () => {
    expect(true).toBe(true);
  });
});

describe('Complexity Judgment', () => {
  it('classifies single-file script tasks as small', () => {
    const result = judgeComplexity({
      id: 'issue-1',
      identifier: 'INT-1',
      title: '写一个 python 文件输出 hello world',
      description: '创建一个简单的 python 脚本文件。',
      priority: 1,
      state: 'Todo',
      project_slug: null,
      project_name: null,
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(result.complexity).toBe('small');
  });

  it('classifies fibonacci single-file tasks as small', () => {
    const result = judgeComplexity({
      id: 'issue-3',
      identifier: 'INT-27',
      title: '写一个计算斐波那契数列的 python 文件',
      description: '创建一个简单的 python 脚本文件来输出结果',
      priority: 1,
      state: 'Todo',
      project_slug: 'proj',
      project_name: 'repo',
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    });

    expect(result.complexity).toBe('small');
  });

  it('classifies simple export-to-txt tasks as small', () => {
    const result = judgeComplexity({
      id: 'issue-2',
      identifier: 'INT-28',
      title: '搜集今日特朗普动态存到 txt 里面',
      description: '把结果保存到 txt 文件中。',
      priority: 1,
      state: 'Todo',
      project_slug: null,
      project_name: null,
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(result.complexity).toBe('small');
  });

  it('classifies simple python program tasks as small', () => {
    const result = judgeComplexity({
      id: 'issue-4',
      identifier: 'INT-30',
      title: '写一个生成随机数的python 程序',
      description: '生成一个简单随机数并打印出来。',
      priority: 1,
      state: 'Todo',
      project_slug: 'proj',
      project_name: 'repo',
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(result.complexity).toBe('small');
  });
});
