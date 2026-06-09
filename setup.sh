#!/bin/bash
# Hive setup — safe to re-run; every step verifies and repairs itself.
# Usage: bash setup.sh [--auto-approve|--no-auto-approve]
# (flags are forwarded to setup-hooks.sh)

set -euo pipefail

install_dependencies() {
  local log_file
  log_file="$(mktemp)"

  if npm install --silent >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi

  echo "  ✗ Dependency install failed. Last 50 lines:"
  tail -50 "$log_file" 2>/dev/null | sed 's/^/    /'
  rm -f "$log_file"
  exit 1
}

echo ""
echo "  Setting up Hive..."
echo ""

# ── Check prerequisites ──────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install it: https://nodejs.org (v20+)"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  ✗ Node.js $NODE_MAJOR found, need 20+. Update: https://nodejs.org"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

# python3 is used by the Claude hooks (identity, auto-approve, telemetry)
# and tunnel URL extraction. Those failures are silenced at runtime, so
# warn loudly here instead of degrading invisibly later.
PY3_OK=1
PY3_HINT=""
if [ "$(uname)" = "Darwin" ]; then
  # /usr/bin/python3 without Command Line Tools is a stub that pops a GUI
  # installer dialog when invoked — treat it as missing.
  PY3_PATH="$(command -v python3 2>/dev/null || true)"
  if [ -z "$PY3_PATH" ]; then
    PY3_OK=0
    PY3_HINT="xcode-select --install"
  elif [ "$PY3_PATH" = "/usr/bin/python3" ] && ! xcode-select -p &>/dev/null; then
    PY3_OK=0
    PY3_HINT="xcode-select --install"
  fi
elif ! command -v python3 &>/dev/null; then
  PY3_OK=0
  PY3_HINT="sudo apt install python3  (or your distro/winget equivalent)"
fi
if [ "$PY3_OK" -eq 1 ]; then
  echo "  ✓ python3"
else
  echo "  ⚠ python3 not available — identity/peer-summary hooks, Windows"
  echo "    inbox delivery, and tunnel URL parsing will silently degrade."
  echo "    Install: $PY3_HINT"
fi

HAS_CLAUDE=0
HAS_CODEX=0
HAS_OPENCLAW=0

if command -v claude &>/dev/null; then
  HAS_CLAUDE=1
fi

if command -v codex &>/dev/null; then
  HAS_CODEX=1
fi

if command -v openclaw &>/dev/null; then
  HAS_OPENCLAW=1
fi

if [ "$HAS_CLAUDE" -eq 0 ] && [ "$HAS_CODEX" -eq 0 ] && [ "$HAS_OPENCLAW" -eq 0 ]; then
  echo "  • No AI CLI found yet. Install at least one before using Hive:"
  echo "      Claude Code: npm install -g @anthropic-ai/claude-code"
  echo "      Codex:       npm install -g @openai/codex"
  echo "      OpenClaw:    npm install -g openclaw"
  echo ""
  echo "    Setup will continue — you can install a CLI after."
fi

if [ "$HAS_CLAUDE" -eq 1 ]; then
  echo "  ✓ Claude Code"
fi

if [ "$HAS_CODEX" -eq 1 ]; then
  echo "  ✓ Codex"
fi

if [ "$HAS_OPENCLAW" -eq 1 ]; then
  echo "  ✓ OpenClaw"
fi

HAS_SWIFT=0
IS_WINDOWS=0
if [ "$(uname -o 2>/dev/null)" = "Msys" ] || [ "$(uname -o 2>/dev/null)" = "Cygwin" ] || [ -n "$MSYSTEM" ]; then
  IS_WINDOWS=1
fi

if [ "$(uname)" = "Darwin" ]; then
  if command -v swiftc &>/dev/null; then
    echo "  ✓ Swift compiler"
    HAS_SWIFT=1
  else
    echo "  • swiftc not found — auto-pilot (auto-approve prompts) will be disabled"
    echo "    To enable later: xcode-select --install && bash setup.sh"
  fi
elif [ "$IS_WINDOWS" -eq 1 ]; then
  echo "  • Windows detected — auto-pilot uses PowerShell automation"
  if command -v wt.exe &>/dev/null; then
    echo "  ✓ Windows Terminal"
  else
    echo "  • Windows Terminal not found — install from Microsoft Store for best experience"
  fi
  if command -v nvidia-smi &>/dev/null; then
    GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")"
    echo "  ✓ GPU: $GPU_NAME"
  fi
else
  echo "  • Linux detected — auto-pilot uses tmux (no swiftc needed)"
  if command -v tmux &>/dev/null; then
    echo "  ✓ tmux"
  else
    echo "  • tmux not found — install for terminal management: sudo apt install tmux"
  fi
  if command -v nvidia-smi &>/dev/null; then
    GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "unknown")"
    echo "  ✓ GPU: $GPU_NAME"
  fi
fi

# ── Install dependencies ─────────────────────────────────────────────

echo ""
echo "  Installing dependencies..."
install_dependencies
echo "  ✓ Dependencies installed"

# ── Compile send-return binary (auto-pilot needs this — optional) ────

if [ "$HAS_SWIFT" -eq 1 ] && [ "$(uname)" = "Darwin" ]; then
  if [ ! -f "$HOME/send-return" ]; then
    echo ""
    echo "  Compiling send-return binary..."
    swiftc -o "$HOME/send-return" tools/send-return.swift
    chmod +x "$HOME/send-return"
    echo "  ✓ ~/send-return compiled"
    echo ""
    echo "  ⚠  Auto-pilot needs Accessibility permission for ~/send-return."
    echo "     Opening System Settings and Finder now..."
    echo "     → Drag 'send-return' from the Finder window into the Accessibility list."
    echo "     → Toggle it on."
    echo ""
    # Open the exact System Settings pane and reveal the binary in Finder
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
    open -R "$HOME/send-return" 2>/dev/null || true
  else
    echo "  ✓ ~/send-return already exists"
  fi
fi

# ── Create Hive auth token ───────────────────────────────────────────

echo ""
echo "  Preparing Hive auth..."
node <<'NODE'
const { randomBytes, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.HOME, '.hive');
const tokenPath = path.join(dir, 'token');
const viewerPath = path.join(dir, 'viewer-token');

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

let token = '';
if (fs.existsSync(tokenPath)) {
  token = fs.readFileSync(tokenPath, 'utf-8').trim();
}

if (!/^[a-f0-9]{64}$/.test(token)) {
  token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
}

const viewer = createHash('sha256').update(token + ':viewer').digest('hex');
fs.writeFileSync(viewerPath, viewer + '\n', { mode: 0o600 });
NODE
echo "  ✓ ~/.hive/token ready"

# ── Set up Claude Code hooks (if Claude is installed) ───────────────

if [ "$HAS_CLAUDE" -eq 1 ]; then
  bash setup-hooks.sh "$@"
  echo "  ✓ Claude Code hooks configured"
else
  echo "  • Claude Code not installed — skipping Claude hook setup"
fi

# Note: no .env file is created. Nothing loads a root .env — the daemon
# and scripts read configuration from the process environment. See
# .env.example for the variables that actually exist.

# ── Done ─────────────────────────────────────────────────────────────

TOKEN="$(cat "$HOME/.hive/token" 2>/dev/null || echo '(not found)')"

echo ""
echo "  ────────────────────────────────────────────────"
echo ""
echo "  Hive is ready."
echo ""
echo "  Your token:"
echo "  $TOKEN"
echo ""
echo "  Next:  npm run launch"
echo ""
echo "  Then open Terminal windows and run"
echo "  'claude', 'codex', or 'openclaw tui'."
echo "  The daemon auto-discovers them in ~3s."
echo ""
echo "  ────────────────────────────────────────────────"
echo ""
