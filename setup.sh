#!/bin/bash
# Hive setup — run once after cloning.
# Usage: bash setup.sh

set -e

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

if ! command -v claude &>/dev/null; then
  echo "  ✗ Claude Code not found. Install it: npm install -g @anthropic-ai/claude-code"
  exit 1
fi
echo "  ✓ Claude Code"

# ── Install dependencies ─────────────────────────────────────────────

echo ""
echo "  Installing dependencies..."
npm install --silent 2>&1 | tail -1
echo "  ✓ Dependencies installed"

# ── Compile send-return binary (auto-pilot needs this) ───────────────

if [ ! -f "$HOME/send-return" ]; then
  echo ""
  echo "  Compiling send-return binary..."
  swiftc -o "$HOME/send-return" tools/send-return.swift
  chmod +x "$HOME/send-return"
  echo "  ✓ ~/send-return compiled"
  echo ""
  echo "  ⚠  Grant Accessibility permission to ~/send-return"
  echo "     System Settings → Privacy & Security → Accessibility"
  echo "     Drag ~/send-return into the list and enable it."
  echo ""
else
  echo "  ✓ ~/send-return already exists"
fi

# ── Set up Claude Code hooks ─────────────────────────────────────────

SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$HOME/.claude"
  echo '{}' > "$SETTINGS"
fi

if grep -q '"hooks"' "$SETTINGS" 2>/dev/null; then
  echo "  ⚠  Hooks already exist in $SETTINGS"
  echo "     Run: bash setup-hooks.sh to see merge instructions."
else
  bash setup-hooks.sh
  echo "  ✓ Claude Code hooks configured"
fi

# ── Create .env from template ────────────────────────────────────────

if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env created from template"
else
  echo "  ✓ .env already exists"
fi

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  Hive is ready.                         │"
echo "  │                                         │"
echo "  │  Start the daemon:                      │"
echo "  │    npm run dev:daemon                   │"
echo "  │                                         │"
echo "  │  Start the dashboard (new terminal):    │"
echo "  │    npm run dev:dashboard                │"
echo "  │                                         │"
echo "  │  Then open 4 Terminal tabs and run       │"
echo "  │  'claude' in each one. The daemon       │"
echo "  │  auto-discovers them in ~3 seconds.     │"
echo "  └─────────────────────────────────────────┘"
echo ""
