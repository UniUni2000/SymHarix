#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  exec bun --env-file="$ROOT_DIR/.env" run "$ROOT_DIR/src/cli/index.ts" "$@"
fi

exec bun run "$ROOT_DIR/src/cli/index.ts" "$@"
