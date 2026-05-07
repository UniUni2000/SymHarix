import * as fs from 'fs/promises';
import * as path from 'path';

export interface RepoProfile {
  repo_ref: string;
  summary: string;
  project_type: string;
  tech_stack: string[];
  key_paths: string[];
  signals: {
    readme_title: string | null;
    package_name: string | null;
    package_scripts: string[];
    top_level_directories: string[];
    top_level_files: string[];
    sample_paths: string[];
  };
  snapshot: {
    top_level_files: string[];
    sample_paths: string[];
    entrypoints: Array<{
      path: string;
      summary: string;
    }>;
  };
  last_indexed_at: string;
}

export interface RepoProfileService {
  resolve(params: {
    repoRef: string;
    localPath: string | null;
  }): Promise<RepoProfile | null>;
}

const README_CANDIDATES = ['README.md', 'README', 'readme.md', 'readme'];
const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
const PRIORITY_DIRECTORIES = ['src', 'app', 'packages', 'docs', 'scripts', 'server', 'client'];

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sentenceCaseSummary(value: string): string {
  const compacted = compactWhitespace(value);
  if (!compacted) {
    return compacted;
  }
  return compacted.length <= 280 ? compacted : `${compacted.slice(0, 277)}...`;
}

function detectProjectType(params: {
  manifestNames: string[];
  packageJson: Record<string, any> | null;
}): string {
  const manifestSet = new Set(params.manifestNames);
  if (manifestSet.has('package.json')) {
    const deps = {
      ...(params.packageJson?.dependencies ?? {}),
      ...(params.packageJson?.devDependencies ?? {}),
    };
    if ('typescript' in deps) {
      return 'node_typescript';
    }
    return 'node_javascript';
  }
  if (manifestSet.has('pyproject.toml')) {
    return 'python';
  }
  if (manifestSet.has('Cargo.toml')) {
    return 'rust';
  }
  if (manifestSet.has('go.mod')) {
    return 'go';
  }
  return 'unknown';
}

function detectTechStack(params: {
  manifestNames: string[];
  packageJson: Record<string, any> | null;
}): string[] {
  const stack: string[] = [];
  const manifestSet = new Set(params.manifestNames);
  if (manifestSet.has('package.json')) {
    stack.push('Node.js');
    stack.push('Bun');
    const deps = {
      ...(params.packageJson?.dependencies ?? {}),
      ...(params.packageJson?.devDependencies ?? {}),
    };
    if ('typescript' in deps) {
      stack.push('TypeScript');
    }
    if ('hono' in deps) {
      stack.push('Hono');
    }
    if ('react' in deps) {
      stack.push('React');
    }
  }
  if (manifestSet.has('pyproject.toml')) {
    stack.push('Python');
  }
  if (manifestSet.has('Cargo.toml')) {
    stack.push('Rust');
  }
  if (manifestSet.has('go.mod')) {
    stack.push('Go');
  }
  return Array.from(new Set(stack));
}

function extractReadmeSummary(readmeContent: string): { title: string | null; summary: string | null } {
  const lines = readmeContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const titleLine = lines.find((line) => /^#\s+/.test(line)) ?? null;
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : null;
  const summaryLine = lines.find((line) => !/^#/.test(line)) ?? null;
  return {
    title,
    summary: summaryLine ? sentenceCaseSummary(summaryLine) : null,
  };
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function listTopLevelEntries(localPath: string): Promise<{
  directories: string[];
  manifests: string[];
  files: string[];
}> {
  try {
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const manifests = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((entry) => MANIFEST_CANDIDATES.includes(entry));
    const files = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    return { directories, manifests, files };
  } catch {
    return { directories: [], manifests: [], files: [] };
  }
}

async function listSamplePaths(localPath: string, directories: string[]): Promise<string[]> {
  const interestingDirs = ['src', 'app', 'packages', 'docs', 'scripts', 'server', 'client']
    .filter((dir) => directories.includes(dir));
  const samplePaths: string[] = [];

  for (const dir of interestingDirs) {
    try {
      const entries = await fs.readdir(path.join(localPath, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        samplePaths.push(`${dir}/${entry.name}`);
        if (samplePaths.length >= 8) {
          return samplePaths;
        }
      }
    } catch {
      continue;
    }
  }

  return samplePaths;
}

function isLikelyEntrypoint(filePath: string): boolean {
  return /(index|main|app|server|cli|bot|start)\./i.test(path.basename(filePath));
}

function summarizeFileSnippet(content: string): string | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('//'))
    .slice(0, 3);
  if (lines.length === 0) {
    return null;
  }
  return sentenceCaseSummary(lines.join(' '));
}

async function buildEntrypointSnapshot(localPath: string, samplePaths: string[]): Promise<Array<{
  path: string;
  summary: string;
}>> {
  const entrypoints: Array<{
    path: string;
    summary: string;
  }> = [];

  for (const samplePath of samplePaths) {
    if (!isLikelyEntrypoint(samplePath)) {
      continue;
    }
    const content = await readIfExists(path.join(localPath, samplePath));
    const summary = content ? summarizeFileSnippet(content) : null;
    if (!summary) {
      continue;
    }
    entrypoints.push({
      path: samplePath,
      summary,
    });
    if (entrypoints.length >= 4) {
      break;
    }
  }

  return entrypoints;
}

export class DefaultRepoProfileService implements RepoProfileService {
  async resolve(params: {
    repoRef: string;
    localPath: string | null;
  }): Promise<RepoProfile | null> {
    if (!params.localPath) {
      return null;
    }

    const readmePath = await (async () => {
      for (const candidate of README_CANDIDATES) {
        const fullPath = path.join(params.localPath!, candidate);
        try {
          await fs.access(fullPath);
          return fullPath;
        } catch {
          continue;
        }
      }
      return null;
    })();

    const { directories, manifests, files } = await listTopLevelEntries(params.localPath);
    const packageJsonPath = manifests.includes('package.json')
      ? path.join(params.localPath, 'package.json')
      : null;

    const [readmeContent, packageJsonContent] = await Promise.all([
      readmePath ? readIfExists(readmePath) : Promise.resolve(null),
      packageJsonPath ? readIfExists(packageJsonPath) : Promise.resolve(null),
    ]);

    const packageJson = packageJsonContent
      ? (() => {
          try {
            return JSON.parse(packageJsonContent) as Record<string, any>;
          } catch {
            return null;
          }
        })()
      : null;

    const { title, summary: readmeSummary } = extractReadmeSummary(readmeContent ?? '');
    const projectType = detectProjectType({
      manifestNames: manifests,
      packageJson,
    });
    const techStack = detectTechStack({
      manifestNames: manifests,
      packageJson,
    });
    const keyPaths = Array.from(new Set([
      ...(readmePath ? [path.basename(readmePath)] : []),
      ...manifests,
      ...PRIORITY_DIRECTORIES.filter((dir) => directories.includes(dir)),
    ]));

    if (!readmeSummary && manifests.length === 0 && directories.length === 0) {
      return null;
    }

    const packageName = typeof packageJson?.name === 'string' ? packageJson.name.trim() : null;
    const packageScripts = Object.keys(packageJson?.scripts ?? {}).sort();
    const samplePaths = await listSamplePaths(params.localPath, directories);
    const entrypoints = await buildEntrypointSnapshot(params.localPath, samplePaths);

    return {
      repo_ref: params.repoRef,
      summary: readmeSummary
        ?? sentenceCaseSummary(`${params.repoRef} repository with ${directories.slice(0, 3).join(', ') || 'a small codebase'} structure.`),
      project_type: projectType,
      tech_stack: techStack,
      key_paths: keyPaths,
      signals: {
        readme_title: title,
        package_name: packageName,
        package_scripts: packageScripts,
        top_level_directories: directories,
        top_level_files: files.slice(0, 12),
        sample_paths: samplePaths,
      },
      snapshot: {
        top_level_files: files.slice(0, 12),
        sample_paths: samplePaths,
        entrypoints,
      },
      last_indexed_at: new Date().toISOString(),
    };
  }
}
