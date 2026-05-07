import { describe, expect, test } from 'bun:test';
import type { RepoProfile } from './repoProfileService';
import { DefaultSupervisorCcAdvisor } from './ccAdvisor';

const repoProfile: RepoProfile = {
  repo_ref: 'acme/demo-app',
  summary: 'Telegram-first supervisor workspace with Bun and TypeScript.',
  project_type: 'node_typescript',
  tech_stack: ['Node.js', 'Bun', 'TypeScript'],
  key_paths: ['README.md', 'src', 'docs'],
  signals: {
    readme_title: 'Demo App',
    package_name: 'demo-app',
    package_scripts: ['build', 'test'],
    top_level_directories: ['docs', 'src'],
  },
  last_indexed_at: '2026-05-06T00:00:00.000Z',
};

describe('DefaultSupervisorCcAdvisor', () => {
  test('returns repo_answer for a repo question', async () => {
    const advisor = new DefaultSupervisorCcAdvisor({
      analyze: async (input) => {
        expect(input.userText).toContain('tech stack');
        expect(input.repoRef).toBe('acme/demo-app');
        expect(input.projectContext).toBe('Telegram assistant intake');
        return JSON.stringify({
          mode: 'repo_answer',
          answer: 'This repo uses Bun, TypeScript, and a Telegram-first supervisor flow.',
          citations: ['README.md', 'src/supervisor/sessionService.ts'],
        });
      },
    });

    const result = await advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'What is the tech stack in this repo?',
      repoProfile,
      projectContext: 'Telegram assistant intake',
    });

    expect(result).toEqual({
      mode: 'repo_answer',
      answer: 'This repo uses Bun, TypeScript, and a Telegram-first supervisor flow.',
      citations: ['README.md', 'src/supervisor/sessionService.ts'],
    });
  });

  test('returns issue_draft with suggested title and body for drafting requests', async () => {
    const advisor = new DefaultSupervisorCcAdvisor({
      analyze: async (input) => {
        expect(input.normalizedUserText).toBe('Draft an issue for improving the supervisor approval card');
        return {
          mode: 'issue_draft',
          title: 'Improve supervisor approval card clarity',
          body: [
            '## Summary',
            'Clarify the Telegram approval card copy and decision actions.',
            '',
            '## Acceptance',
            '- Recommendation-first summary',
            '- Stable approve / revise controls',
          ].join('\n'),
        };
      },
    });

    const result = await advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: '  Draft an issue for improving the supervisor approval card  ',
      repoProfile,
      projectContext: null,
    });

    expect(result).toEqual({
      mode: 'issue_draft',
      title: 'Improve supervisor approval card clarity',
      body: [
        '## Summary',
        'Clarify the Telegram approval card copy and decision actions.',
        '',
        '## Acceptance',
        '- Recommendation-first summary',
        '- Stable approve / revise controls',
      ].join('\n'),
    });
  });

  test('returns clarify when the backend asks a follow-up question', async () => {
    const advisor = new DefaultSupervisorCcAdvisor({
      analyze: async () => ({
        mode: 'clarify',
        question: 'Which Telegram surface should this focus on first?',
      }),
    });

    const result = await advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'Help me shape the next advisor step',
      repoProfile,
      projectContext: 'Supervisor chat',
    });

    expect(result).toEqual({
      mode: 'clarify',
      question: 'Which Telegram surface should this focus on first?',
    });
  });

  test('returns null when the backend leaves required public fields blank after trimming', async () => {
    const advisor = new DefaultSupervisorCcAdvisor({
      analyze: async ({ normalizedUserText }) => {
        switch (normalizedUserText) {
          case 'blank repo answer':
            return { mode: 'repo_answer', answer: '   ' };
          case 'blank issue draft title':
            return { mode: 'issue_draft', title: '   ', body: 'Has body' };
          case 'blank issue draft body':
            return { mode: 'issue_draft', title: 'Has title', body: '   ' };
          case 'blank clarify question':
            return { mode: 'clarify', question: '   ' };
          default:
            return null;
        }
      },
    });

    await expect(advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'blank repo answer',
      repoProfile,
      projectContext: null,
    })).resolves.toBeNull();

    await expect(advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'blank issue draft title',
      repoProfile,
      projectContext: null,
    })).resolves.toBeNull();

    await expect(advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'blank issue draft body',
      repoProfile,
      projectContext: null,
    })).resolves.toBeNull();

    await expect(advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'blank clarify question',
      repoProfile,
      projectContext: null,
    })).resolves.toBeNull();
  });

  test('returns null when the backend response is invalid or unparseable', async () => {
    const advisor = new DefaultSupervisorCcAdvisor({
      analyze: async () => 'definitely not json',
    });

    const result = await advisor.advise({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      userText: 'Please help with something vague',
      repoProfile,
      projectContext: null,
    });

    expect(result).toBeNull();
  });
});
