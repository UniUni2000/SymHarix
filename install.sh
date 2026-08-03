#!/usr/bin/env sh
set -eu

REPOSITORY=${SYMHARIX_REPOSITORY:-UniUni2000/SymHarix}
INSTALL_ROOT=${SYMHARIX_INSTALL_DIR:-"${HOME}/.local/share/symharix"}
BIN_DIR=${SYMHARIX_BIN_DIR:-"${HOME}/.local/bin"}

fail() {
  printf 'SymHarix installer error: %s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

need curl
need mktemp
need grep
if [ "${SYMHARIX_SKIP_PREREQUISITES:-0}" != '1' ]; then
  need git
  command -v "${SYMHARIX_PYTHON_BIN:-python3}" >/dev/null 2>&1 \
    || fail 'Python 3 is required. Install Python 3, then rerun this installer.'
fi

case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  *) fail "unsupported operating system: $(uname -s). Windows users should run install.ps1." ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

ASSET="symharix-${PLATFORM}-${ARCH}.tar.gz"
if [ -n "${SYMHARIX_DOWNLOAD_BASE:-}" ]; then
  DOWNLOAD_BASE=${SYMHARIX_DOWNLOAD_BASE%/}
elif [ -n "${SYMHARIX_VERSION:-}" ]; then
  RELEASE_TAG=${SYMHARIX_VERSION}
  case "$RELEASE_TAG" in v*) ;; *) RELEASE_TAG="v${RELEASE_TAG}" ;; esac
  DOWNLOAD_BASE="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}"
else
  DOWNLOAD_BASE="https://github.com/${REPOSITORY}/releases/latest/download"
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/symharix-install.XXXXXX")
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

printf 'Downloading %s...\n' "$ASSET"
curl --fail --location --silent --show-error --output "$TEMP_DIR/$ASSET" "$DOWNLOAD_BASE/$ASSET"
curl --fail --location --silent --show-error --output "$TEMP_DIR/checksums.txt" "$DOWNLOAD_BASE/checksums.txt"

EXPECTED=$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$TEMP_DIR/checksums.txt")
[ -n "$EXPECTED" ] || fail "checksums.txt has no entry for $ASSET"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TEMP_DIR/$ASSET" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{print $1}')
else
  fail 'sha256sum or shasum is required to verify the download'
fi
[ "$ACTUAL" = "$EXPECTED" ] || fail "checksum mismatch for $ASSET"

mkdir -p "$TEMP_DIR/extract"
tar -xzf "$TEMP_DIR/$ASSET" -C "$TEMP_DIR/extract"
PACKAGE_ROOT="$TEMP_DIR/extract/SymHarix"
[ -x "$PACKAGE_ROOT/bin/symharix" ] || fail 'release archive does not contain SymHarix/bin/symharix'
[ -f "$PACKAGE_ROOT/VERSION" ] || fail 'release archive does not contain VERSION'
VERSION=$(tr -d '\r\n' < "$PACKAGE_ROOT/VERSION")
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' \
  || fail "invalid package version: $VERSION"

VERSIONS_DIR="$INSTALL_ROOT/versions"
DESTINATION="$VERSIONS_DIR/$VERSION"
mkdir -p "$VERSIONS_DIR" "$BIN_DIR"
case "$DESTINATION" in
  "$VERSIONS_DIR"/*) ;;
  *) fail "unsafe install destination: $DESTINATION" ;;
esac
STAGED_DESTINATION="$VERSIONS_DIR/.${VERSION}.installing"
rm -rf "$STAGED_DESTINATION"
mv "$PACKAGE_ROOT" "$STAGED_DESTINATION"
rm -rf "$DESTINATION"
mv "$STAGED_DESTINATION" "$DESTINATION"

if [ "${SYMHARIX_SKIP_PREREQUISITES:-0}" != '1' ]; then
  DATA_HOME=${SYMHARIX_HOME:-"${HOME}/.symharix"}
  PYTHON=${SYMHARIX_PYTHON_BIN:-python3}
  mkdir -p "$DATA_HOME"
  if [ ! -x "$DATA_HOME/.venv/bin/python3" ]; then
    printf 'Creating isolated Python environment...\n'
    "$PYTHON" -m venv "$DATA_HOME/.venv" \
      || fail 'Python could not create a virtual environment. Install the Python venv component and retry.'
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    REQUIREMENTS_DIGEST=$(sha256sum "$DESTINATION/scripts/requirements.txt" | awk '{print $1}')
  else
    REQUIREMENTS_DIGEST=$(shasum -a 256 "$DESTINATION/scripts/requirements.txt" | awk '{print $1}')
  fi
  REQUIREMENTS_MARKER="$DATA_HOME/.venv/.symharix-requirements-sha256"
  INSTALLED_REQUIREMENTS_DIGEST=''
  if [ -f "$REQUIREMENTS_MARKER" ]; then
    INSTALLED_REQUIREMENTS_DIGEST=$(tr -d '\r\n' < "$REQUIREMENTS_MARKER")
  fi
  if [ "$INSTALLED_REQUIREMENTS_DIGEST" != "$REQUIREMENTS_DIGEST" ]; then
    printf 'Installing SymHarix Python runtime dependencies...\n'
    "$DATA_HOME/.venv/bin/python3" -m pip install \
      --disable-pip-version-check \
      --quiet \
      --requirement "$DESTINATION/scripts/requirements.txt" \
      || fail 'Python dependency installation failed.'
    printf '%s\n' "$REQUIREMENTS_DIGEST" > "$REQUIREMENTS_MARKER"
  fi
fi

printf '%s\n' "$VERSION" > "$INSTALL_ROOT/current-version"

SHIM_PATH="$BIN_DIR/symharix"
STAGED_SHIM="$BIN_DIR/.symharix-link.$$"
rm -f "$STAGED_SHIM"
ln -s "$DESTINATION/bin/symharix" "$STAGED_SHIM"
mv -f "$STAGED_SHIM" "$SHIM_PATH"

printf '\nSymHarix %s installed successfully.\n' "$VERSION"
printf 'Command: %s/symharix\n' "$BIN_DIR"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf 'Add this directory to PATH if needed:\n  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

if [ "${SYMHARIX_NO_CONFIGURE:-0}" != '1' ] && [ -t 0 ] && [ -t 1 ]; then
  exec "$BIN_DIR/symharix" configure
fi

printf 'Next: %s/symharix configure\n' "$BIN_DIR"
