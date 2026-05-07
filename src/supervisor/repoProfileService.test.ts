import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DefaultRepoProfileService } from './repoProfileService';

describe('DefaultRepoProfileService', () => {
  test('builds a compact repo profile from README, package.json, and top-level folders', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-repo-profile-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        [
          '# Stellar Lab',
          '',
          'Stellar Lab is a Telegram-first orchestration workspace for planning scientific jobs.',
          'It helps operators draft issues, inspect runtime state, and route work into repository automation.',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'stellar-lab',
          private: true,
          scripts: {
            start: 'bun run src/index.ts',
            test: 'bun test',
          },
          dependencies: {
            hono: '^4.0.0',
          },
          devDependencies: {
            typescript: '^5.0.0',
          },
        }, null, 2),
        'utf8',
      );
      fs.mkdirSync(path.join(repoRoot, 'src'));
      fs.mkdirSync(path.join(repoRoot, 'docs'));
      fs.mkdirSync(path.join(repoRoot, 'scripts'));
      fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
      fs.writeFileSync(
        path.join(repoRoot, 'src', 'server.ts'),
        [
          'import { Hono } from "hono";',
          '',
          'const app = new Hono();',
          'app.get("/", (c) => c.text("ok"));',
          '',
          'export default app;',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(path.join(repoRoot, 'docs', 'ARCHITECTURE.md'), '# Notes\n', 'utf8');

      const service = new DefaultRepoProfileService();
      const profile = await service.resolve({
        repoRef: 'UniUni2000/test2',
        localPath: repoRoot,
      });

      expect(profile).not.toBeNull();
      expect(profile?.repo_ref).toBe('UniUni2000/test2');
      expect(profile?.project_type).toBe('node_typescript');
      expect(profile?.summary).toContain('Telegram-first orchestration workspace');
      expect(profile?.tech_stack).toEqual(expect.arrayContaining(['Bun', 'TypeScript', 'Hono']));
      expect(profile?.key_paths).toEqual(expect.arrayContaining(['README.md', 'package.json', 'src', 'docs']));
      expect(profile?.signals.readme_title).toBe('Stellar Lab');
      expect(profile?.signals.package_name).toBe('stellar-lab');
      expect(profile?.signals.top_level_files).toEqual(expect.arrayContaining(['README.md', 'package.json']));
      expect(profile?.signals.sample_paths).toEqual(expect.arrayContaining(['src/index.ts', 'docs/ARCHITECTURE.md']));
      expect(profile?.snapshot.top_level_files).toEqual(expect.arrayContaining(['README.md', 'package.json']));
      expect(profile?.snapshot.sample_paths).toEqual(expect.arrayContaining(['src/index.ts', 'src/server.ts']));
      expect(profile?.snapshot.entrypoints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'src/server.ts',
          summary: expect.stringContaining('Hono'),
        }),
      ]));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('returns null when there is no local repository path', async () => {
    const service = new DefaultRepoProfileService();
    const profile = await service.resolve({
      repoRef: 'UniUni2000/test2',
      localPath: null,
    });

    expect(profile).toBeNull();
  });
});
