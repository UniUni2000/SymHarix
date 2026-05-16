#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="$ROOT_DIR/claude-code"
RUNTIME_PACKAGE="$RUNTIME_ROOT/package.json"
RUNTIME_ENTRYPOINT="$RUNTIME_ROOT/bin/claude-symharix"
DEPS_MARKER="$RUNTIME_ROOT/node_modules/lodash-es/sumBy.js"

fail() {
  echo "runtime check failed: $*" >&2
  exit 1
}

command -v bun >/dev/null 2>&1 || fail "Bun is not installed or not on PATH."
[[ -f "$RUNTIME_PACKAGE" ]] || fail "Missing bundled runtime package.json at $RUNTIME_PACKAGE."
[[ -x "$RUNTIME_ENTRYPOINT" ]] || fail "Missing executable runtime entrypoint at $RUNTIME_ENTRYPOINT."

if [[ ! -f "$DEPS_MARKER" ]]; then
  fail "Bundled runtime dependencies are missing. Run: (cd claude-code && bun install)"
fi

cd "$ROOT_DIR"

node <<'NODE'
const cp = require('child_process');
const path = require('path');
const adapter = require('./scripts/claude-adapter.cjs');

const runtimeRoot = path.resolve('claude-code');
const entrypoint = adapter.resolveClaudeRuntimeCliPath(runtimeRoot);

if (!entrypoint.endsWith(path.join('bin', 'claude-symharix'))) {
  console.error(`runtime check failed: adapter resolved ${entrypoint}, expected claude-symharix.`);
  process.exit(1);
}

const result = cp.spawnSync(entrypoint, ['--help'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE || '1',
  },
  encoding: 'utf8',
});

if (result.status !== 0) {
  const detail = (result.stderr || result.stdout || '').trim().split('\n').find(Boolean);
  console.error(`runtime check failed: adapter could not spawn claude-symharix: ${detail || `exit ${result.status}`}`);
  process.exit(1);
}
NODE

echo "runtime check passed"
