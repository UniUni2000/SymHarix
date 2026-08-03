import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  CURRENT_DATABASE_FILENAME,
  LEGACY_DATABASE_FILENAME,
  resolveDefaultDatabasePath,
} from './path';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'symharix-db-path-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveDefaultDatabasePath', () => {
  test('uses the current brand for a new installation', () => {
    const root = temporaryRoot();
    expect(resolveDefaultDatabasePath(root)).toBe(path.join(root, CURRENT_DATABASE_FILENAME));
  });

  test('keeps an existing legacy database in place', () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, LEGACY_DATABASE_FILENAME), '');
    expect(resolveDefaultDatabasePath(root)).toBe(path.join(root, LEGACY_DATABASE_FILENAME));
  });

  test('prefers the current database when both files exist', () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, LEGACY_DATABASE_FILENAME), '');
    writeFileSync(path.join(root, CURRENT_DATABASE_FILENAME), '');
    expect(resolveDefaultDatabasePath(root)).toBe(path.join(root, CURRENT_DATABASE_FILENAME));
  });
});
