import * as fs from 'fs/promises';
import * as path from 'path';

const SURFACE_PATTERNS: Array<{ area: string; prefix: string }> = [
  { area: 'runtime', prefix: 'src/runtime/' },
  { area: 'server', prefix: 'src/server/' },
  { area: 'bots', prefix: 'src/bots/' },
  { area: 'orchestrator', prefix: 'src/orchestrator/' },
  { area: 'python-bridge', prefix: 'scripts/' },
];

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
}

function stripExtension(segment: string): string {
  return segment.replace(/\.[^.\/]+$/, '');
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
  }
  return results;
}

export function deriveTouchedAreas(paths: string[]): string[] {
  const areas: string[] = [];
  const seen = new Set<string>();

  for (const candidate of paths.map(normalizePath)) {
    const match = SURFACE_PATTERNS.find((surface) => candidate.startsWith(surface.prefix));
    if (!match || seen.has(match.area)) {
      continue;
    }
    seen.add(match.area);
    areas.push(match.area);
  }

  return areas;
}

export function derivePathFamilies(paths: string[]): string[] {
  const families: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const normalized = normalizePath(rawPath);
    let family: string | null = null;

    if (normalized.startsWith('src/')) {
      const [, area, nextSegment] = normalized.split('/');
      if (area && nextSegment) {
        family = `${area}/${stripExtension(nextSegment)}`;
      }
    } else if (normalized.startsWith('scripts/')) {
      const [, nextSegment] = normalized.split('/');
      if (nextSegment) {
        family = `python-bridge/${stripExtension(nextSegment)}`;
      }
    }

    if (!family || seen.has(family)) {
      continue;
    }
    seen.add(family);
    families.push(family);
  }

  return families;
}

export function deriveBoundaryEdges(paths: string[]): string[] {
  const areas = deriveTouchedAreas(paths).sort();
  if (areas.length < 2) {
    return [];
  }

  const edges: string[] = [];
  for (let index = 0; index < areas.length; index += 1) {
    for (let next = index + 1; next < areas.length; next += 1) {
      edges.push(`${areas[index]}<->${areas[next]}`);
    }
  }
  return edges;
}

function isTsLikeFile(filePath: string): boolean {
  return /\.(tsx?|jsx?|mjs|cjs)$/i.test(filePath);
}

function isPythonFile(filePath: string): boolean {
  return /\.py$/i.test(filePath);
}

function resolveTsImport(workspacePath: string, fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const fromDir = path.dirname(fromPath);
  return normalizePath(path.relative(workspacePath, path.resolve(fromDir, specifier)));
}

function resolvePythonImport(workspacePath: string, filePath: string, specifier: string): string | null {
  const normalized = specifier.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('.')) {
    const dots = normalized.match(/^\.+/)?.[0].length ?? 1;
    const modulePath = normalized.slice(dots).replace(/\./g, '/');
    const baseDir = dots > 1
      ? path.resolve(path.dirname(filePath), ...new Array(dots - 1).fill('..'))
      : path.dirname(filePath);
    const resolved = path.resolve(baseDir, modulePath || '.');
    return normalizePath(path.relative(workspacePath, resolved));
  }

  if (normalized.startsWith('src.') || normalized.startsWith('scripts.')) {
    return normalizePath(normalized.replace(/\./g, '/'));
  }

  return null;
}

async function readLocalImportTargets(workspacePath: string, touchedPath: string): Promise<string[]> {
  const normalizedTouchedPath = normalizePath(touchedPath);
  const absolutePath = path.join(workspacePath, normalizedTouchedPath);
  let content = '';
  try {
    content = await fs.readFile(absolutePath, 'utf8');
  } catch {
    return [];
  }

  const targets: string[] = [];
  if (isTsLikeFile(normalizedTouchedPath)) {
    const patterns = [
      /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
      /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const specifier = match[1]?.trim();
        if (!specifier) {
          continue;
        }
        targets.push(resolveTsImport(workspacePath, absolutePath, specifier));
      }
    }
  } else if (isPythonFile(normalizedTouchedPath)) {
    for (const match of content.matchAll(/from\s+([.\w]+)\s+import\s+[\w*, ]+/g)) {
      targets.push(resolvePythonImport(workspacePath, absolutePath, match[1] ?? ''));
    }
    for (const match of content.matchAll(/import\s+([.\w]+)/g)) {
      targets.push(resolvePythonImport(workspacePath, absolutePath, match[1] ?? ''));
    }
  }

  return dedupeStrings(targets);
}

export async function deriveImportEdges(params: {
  workspacePath: string;
  touchedPaths: string[];
}): Promise<string[]> {
  const edges: string[] = [];
  const seen = new Set<string>();

  for (const touchedPath of params.touchedPaths.map(normalizePath)) {
    const sourceFamilies = derivePathFamilies([touchedPath]);
    const sourceFamily = sourceFamilies[0] ?? null;
    if (!sourceFamily) {
      continue;
    }
    const targets = await readLocalImportTargets(params.workspacePath, touchedPath);
    for (const target of targets) {
      const targetFamily = derivePathFamilies([target])[0] ?? null;
      if (!targetFamily) {
        continue;
      }
      const edge = `${sourceFamily}->${targetFamily}`;
      if (seen.has(edge)) {
        continue;
      }
      seen.add(edge);
      edges.push(edge);
    }
  }

  return edges;
}

export function deriveArchitecturalTarget(params: {
  touchedAreas: string[];
  pathFamilies: string[];
  boundaryEdges: string[];
  importEdges: string[];
}): string | null {
  if (params.boundaryEdges.length > 0) {
    return params.boundaryEdges.join('+');
  }
  if (params.importEdges.length > 0) {
    return params.importEdges.join('+');
  }
  if (params.pathFamilies.length > 0) {
    return params.pathFamilies.join('+');
  }
  return params.touchedAreas.length > 0 ? params.touchedAreas.join('+') : null;
}

export function deriveControlPathFamilies(pathFamilies: string[]): string[] {
  return dedupeStrings(pathFamilies.filter((family) => (
    family.startsWith('runtime/') ||
    family.startsWith('server/routes/') ||
    family === 'server/routes' ||
    family.startsWith('bots/') ||
    family.startsWith('orchestrator/') ||
    family === 'python-bridge/cli'
  )));
}

export async function analyzeTouchedPathsArchitecture(params: {
  workspacePath: string;
  touchedPaths: string[];
}): Promise<{
  touched_areas: string[];
  path_families: string[];
  boundary_edges: string[];
  import_edges: string[];
  architectural_target: string | null;
}> {
  const touchedAreas = deriveTouchedAreas(params.touchedPaths);
  const pathFamilies = derivePathFamilies(params.touchedPaths);
  const boundaryEdges = deriveBoundaryEdges(params.touchedPaths);
  const importEdges = await deriveImportEdges(params);

  return {
    touched_areas: touchedAreas,
    path_families: pathFamilies,
    boundary_edges: boundaryEdges,
    import_edges: importEdges,
    architectural_target: deriveArchitecturalTarget({
      touchedAreas,
      pathFamilies,
      boundaryEdges,
      importEdges,
    }),
  };
}
