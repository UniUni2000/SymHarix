#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const ignoredDirectories = new Set([
  '.git',
  '.runtime-cache',
  'claude-code',
  'dist',
  'node_modules',
]);
const inheritedEnvironmentKeys = [
  'PATH',
  'HOME',
  'TMPDIR',
  'CI',
  'LANG',
  'LC_ALL',
  'TERM',
];

function buildTestEnvironment(env = process.env) {
  const clean = { NODE_ENV: 'test' };
  for (const key of inheritedEnvironmentKeys) {
    if (typeof env[key] === 'string') clean[key] = env[key];
  }
  return clean;
}

function collectTestFiles(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectTestFiles(path.join(directory, entry.name), output);
      }
      continue;
    }
    if (/\.test\.(?:js|ts)$/.test(entry.name)) {
      output.push(path.relative(projectRoot, path.join(directory, entry.name)));
    }
  }
  return output;
}

function readCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`(\\d+) ${label}`, 'g'))];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : 0;
}

function main() {
  const files = collectTestFiles(projectRoot).sort();
  let passed = 0;
  let skipped = 0;
  const startedAt = Date.now();

  console.log(`Running ${files.length} test files in isolated Bun processes...`);
  for (const [index, file] of files.entries()) {
    const result = cp.spawnSync(
      'bun',
      [
        '--env-file=/dev/null',
        'test',
        `./${file}`,
        '--reporter=dot',
        '--timeout=15000',
      ],
      {
        cwd: projectRoot,
        env: buildTestEnvironment(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error || result.status !== 0) {
      process.stdout.write(output);
      console.error(
        `FAILED ${file} (${index + 1}/${files.length}, exit ${result.status ?? 'unknown'})`,
      );
      process.exit(result.status || 1);
    }
    passed += readCount(output, 'pass');
    skipped += readCount(output, 'skip');
    console.log(`PASS ${file} (${index + 1}/${files.length})`);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Isolated test suite passed: ${passed} tests, ${skipped} skipped, ${files.length} files, ${seconds}s.`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildTestEnvironment,
  collectTestFiles,
  readCount,
};
