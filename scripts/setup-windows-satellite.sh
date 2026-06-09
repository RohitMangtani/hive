#!/bin/bash
# DEPRECATED: thin bootstrap wrapper for Windows/WSL2 satellites.
#
# The supported satellite path is:
#   bash scripts/install.sh --connect <tunnel-url> <token>
# (see the README "Windows" section). This wrapper only prepares a stock
# WSL2 Ubuntu (tmux, git, Node.js, Claude Code), clones Hive if needed,
# and then delegates to install.sh --connect. It no longer writes any
# ~/.hive files itself; earlier versions clobbered ~/.hive/token on every
# run, which install.sh/setup.sh now manage with proper guards.
#
# Usage:
#   bash setup-windows-satellite.sh <primary-wss-url> <token>

set -euo pipefail

PRIMARY_URL="${1:-}"
TOKEN="${2:-}"

if [ -z "$PRIMARY_URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: bash setup-windows-satellite.sh <primary-wss-url> <token>"
  echo ""
  echo "Get these from the primary Hive dashboard, or run 'npm run invite'"
  echo "on the primary machine."
  exit 1
fi

echo ""
echo "NOTE: this script is a deprecated wrapper. The supported path is:"
echo "  bash scripts/install.sh --connect <tunnel-url> <token>"
echo "Continuing: bootstrapping WSL2 prerequisites, then delegating to it."
echo ""

# 1. System packages (stock WSL2 Ubuntu)
echo "[1/4] Installing system packages..."
if command -v apt-get &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq tmux git curl build-essential python3
else
  echo "  apt-get not found — skipping. Install tmux/git/curl/python3 manually if missing."
fi

# 2. Node.js (via nvm) if missing
echo "[2/4] Checking Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
else
  echo "  Node.js already installed: $(node --version)"
fi

# 3. Claude Code if missing
echo "[3/4] Checking Claude Code..."
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
else
  echo "  Claude Code already installed"
fi

# 4. Locate or clone the Hive repo, then delegate to the supported path
echo "[4/4] Delegating to install.sh --connect..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/install.sh" ]; then
  HIVE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  HIVE_DIR="$HOME/hive"
  if [ ! -d "$HIVE_DIR" ]; then
    git clone https://github.com/RohitMangtani/hive.git "$HIVE_DIR"
  else
    (cd "$HIVE_DIR" && git pull --ff-only) || true
  fi
fi

cd "$HIVE_DIR"
exec bash scripts/install.sh --connect "$PRIMARY_URL" "$TOKEN"
