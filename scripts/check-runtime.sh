#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v bun >/dev/null 2>&1 || {
  echo "runtime check failed: Bun is not installed or not on PATH." >&2
  exit 1
}

node ./scripts/opencode-runtime.cjs check --strict
bun test \
  ./scripts/opencode-adapter.test.js \
  ./scripts/opencode-runtime.test.js \
  ./scripts/upgrade-opencode.test.js \
  ./src/agent/openCodeRuntime.test.ts

echo "runtime check passed"
