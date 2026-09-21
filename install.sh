#!/usr/bin/env bash
# install.sh — Installer for webpify
set -euo pipefail

BIN_NAME="webpify"
INSTALL_DIR="${HOME}/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── 1. Handle Uninstall ───────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" || "${1:-}" == "-u" ]]; then
  echo "Uninstalling $BIN_NAME from $INSTALL_DIR..."
  if [[ -f "$INSTALL_DIR/$BIN_NAME" ]]; then
    if [[ -w "$INSTALL_DIR" ]]; then
      rm -f "$INSTALL_DIR/$BIN_NAME"
    else
      sudo rm -f "$INSTALL_DIR/$BIN_NAME"
    fi
    echo -e "${GREEN}✓ Successfully uninstalled $BIN_NAME.${NC}"
  else
    echo -e "${YELLOW}Notice: $BIN_NAME is not found in $INSTALL_DIR.${NC}"
  fi
  exit 0
fi

# ── 2. Locate Source File ────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/$BIN_NAME" ]]; then
  SRC="$SCRIPT_DIR/$BIN_NAME"
elif [[ -f "$SCRIPT_DIR/$BIN_NAME.sh" ]]; then
  SRC="$SCRIPT_DIR/$BIN_NAME.sh"
elif [[ -f "$SCRIPT_DIR/bin/$BIN_NAME" ]]; then
  SRC="$SCRIPT_DIR/bin/$BIN_NAME"
else
  echo -e "${RED}Error: Could not find '$BIN_NAME' or '$BIN_NAME.sh' in repository.${NC}" >&2
  exit 1
fi

# ── 3. Install Executable ─────────────────────────────────────────────────────
echo "Installing $BIN_NAME to $INSTALL_DIR..."

# Create directory if it doesn't exist
if [[ ! -d "$INSTALL_DIR" ]]; then
  sudo mkdir -p "$INSTALL_DIR"
fi

# Copy and set executable permissions
if [[ -w "$INSTALL_DIR" ]]; then
  install -m 755 "$SRC" "$INSTALL_DIR/$BIN_NAME"
else
  echo "Administrator privileges required to write to $INSTALL_DIR:"
  sudo install -m 755 "$SRC" "$INSTALL_DIR/$BIN_NAME"
fi

echo -e "${GREEN}✓ Successfully installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME${NC}"

# ── 4. Dependency Check ───────────────────────────────────────────────────────
echo ""
echo "Checking dependencies…"
if ! command -v sharp &>/dev/null; then
  echo -e "${YELLOW}⚠️  Warning: 'sharp-cli' is not detected.${NC}"
  echo "   webpify requires sharp-cli to run."
  echo "   Install it by running:"
  echo -e "   ${GREEN}npm install -g sharp-cli${NC}"
else
  echo -e "${GREEN}✓ Dependency 'sharp-cli' found.${NC}"
fi

echo ""
echo -e "🎉 You're all set! Try running: ${GREEN}$BIN_NAME --help${NC}"