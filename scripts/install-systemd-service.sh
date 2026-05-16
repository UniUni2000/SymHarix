#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SYMHARIX_SERVICE_NAME:-symharix}"
SERVICE_USER="${SYMHARIX_SERVICE_USER:-$(id -un)}"
SERVICE_PORT="${SYMHARIX_SERVICE_PORT:-${PORT:-3000}}"
BUN_BIN="${SYMHARIX_BUN_BIN:-$(command -v bun || true)}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "systemd service installation is only supported on Linux." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found. Use tmux/screen/nohup, or install on a systemd-based Linux server." >&2
  exit 1
fi

if [[ -z "$BUN_BIN" ]]; then
  echo "bun was not found in PATH. Install Bun first, then re-run this command." >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/.env" || ! -f "$ROOT_DIR/WORKFLOW.md" ]]; then
  echo "[symharix] preparing .env and WORKFLOW.md from examples when missing"
  (cd "$ROOT_DIR" && "$BUN_BIN" run setup)
fi

if [[ ! -f "$ROOT_DIR/.env" || ! -f "$ROOT_DIR/WORKFLOW.md" ]]; then
  echo "Expected .env and WORKFLOW.md to exist before installing the service." >&2
  exit 1
fi

quote_systemd() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

BUN_DIR="$(dirname "$BUN_BIN")"
PATH_ENV="$BUN_DIR:/usr/local/bin:/usr/bin:/bin"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT

cat >"$TMP_UNIT" <<UNIT
[Unit]
Description=SymHarix Telegram-first AI Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=$(quote_systemd "$ROOT_DIR")
Environment="PATH=${PATH_ENV}"
Environment="PORT=${SERVICE_PORT}"
ExecStart=$(quote_systemd "$BUN_BIN") --env-file=$(quote_systemd "$ROOT_DIR/.env") run $(quote_systemd "$ROOT_DIR/src/cli/index.ts") --port ${SERVICE_PORT}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

echo "[symharix] installing ${UNIT_PATH}"
sudo install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

echo "[symharix] service installed and started"
echo "  status: sudo systemctl status ${SERVICE_NAME} --no-pager"
echo "  logs:   sudo journalctl -u ${SERVICE_NAME} -f"
echo "  stop:   sudo systemctl stop ${SERVICE_NAME}"
