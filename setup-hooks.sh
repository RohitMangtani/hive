#!/bin/bash
# One-time setup: install or update Hive hooks in ~/.claude/settings.json.
# Run: bash setup-hooks.sh [--auto-approve|--no-auto-approve]
#
# The PreToolUse auto-approve hook is machine-wide, so it is consent-gated:
#   --auto-approve       install it without asking
#   --no-auto-approve    skip it, and remove it if a previous run installed it
#   (neither)            interactive terminal: explain and ask Y/n
#                        non-interactive: install it (unattended automation
#                        depends on it) and print a loud notice + removal command
# HIVE_AUTO_APPROVE=1|0 in the environment acts like the flags (install.sh
# passes consent through this variable).

set -e

AUTO_APPROVE_MODE=""
for arg in "$@"; do
  case "$arg" in
    --auto-approve)    AUTO_APPROVE_MODE="on" ;;
    --no-auto-approve) AUTO_APPROVE_MODE="off" ;;
  esac
done
if [ -z "$AUTO_APPROVE_MODE" ]; then
  case "${HIVE_AUTO_APPROVE:-}" in
    1) AUTO_APPROVE_MODE="on" ;;
    0) AUTO_APPROVE_MODE="off" ;;
  esac
fi

if ! command -v claude &>/dev/null; then
  echo "Claude Code not found. Skipping Claude hook installation."
  echo "Install it later with: npm install -g @anthropic-ai/claude-code"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"
HIVE_DIR="$HOME/.hive"
TOKEN_PATH="$HIVE_DIR/token"
VIEWER_PATH="$HIVE_DIR/viewer-token"
IDENTITY_SRC="$REPO_ROOT/apps/daemon/src/hooks/identity.sh"
IDENTITY_DST="$HIVE_DIR/identity.sh"
AUTO_APPROVE_CMD="$REPO_ROOT/apps/daemon/src/hooks/auto-approve.sh"
DAEMON_URL="${HIVE_DAEMON_URL:-http://localhost:3001}"

mkdir -p "$HOME/.claude" "$HIVE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

if [ ! -f "$IDENTITY_SRC" ]; then
  echo "Missing identity hook source: $IDENTITY_SRC"
  exit 1
fi

# Atomic copy: write to temp, set permissions, then move into place.
# Prevents a window where the file exists with wrong permissions.
IDENTITY_TMP="${IDENTITY_DST}.tmp.$$"
cp "$IDENTITY_SRC" "$IDENTITY_TMP"
chmod +x "$IDENTITY_TMP"
mv "$IDENTITY_TMP" "$IDENTITY_DST"

if [ ! -f "$TOKEN_PATH" ]; then
  node <<'NODE'
const { randomBytes, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const home = process.env.HOME;
const dir = path.join(home, '.hive');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString('hex');
fs.writeFileSync(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
const viewer = createHash('sha256').update(token + ':viewer').digest('hex');
fs.writeFileSync(path.join(dir, 'viewer-token'), viewer + '\n', { mode: 0o600 });
NODE
fi

if [ ! -f "$VIEWER_PATH" ]; then
  node <<'NODE'
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const home = process.env.HOME;
const dir = path.join(home, '.hive');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf-8').trim();
const viewer = createHash('sha256').update(token + ':viewer').digest('hex');
fs.writeFileSync(path.join(dir, 'viewer-token'), viewer + '\n', { mode: 0o600 });
NODE
fi

TOKEN=$(tr -d '\n' < "$TOKEN_PATH")
if [ -z "$TOKEN" ]; then
  echo "Failed to read $TOKEN_PATH"
  exit 1
fi

# ── Auto-approve consent ─────────────────────────────────────────────
# Decide whether the machine-wide PreToolUse auto-approve hook gets
# installed. Re-runs with the hook already present keep it without asking
# (verify-and-repair); withdrawing consent is always --no-auto-approve.

AUTO_APPROVE_ALREADY_INSTALLED=0
if grep -q 'auto-approve\.sh' "$SETTINGS" 2>/dev/null; then
  AUTO_APPROVE_ALREADY_INSTALLED=1
fi

if [ -z "$AUTO_APPROVE_MODE" ]; then
  if [ "$AUTO_APPROVE_ALREADY_INSTALLED" -eq 1 ]; then
    # Previously consented (hook is present) — keep and repair it silently.
    AUTO_APPROVE_MODE="on"
  elif [ -t 0 ]; then
    echo ""
    echo "  Hive wants to install a machine-wide Claude Code auto-approve hook."
    echo ""
    echo "  What it does:"
    echo "    - Adds a PreToolUse hook to ~/.claude/settings.json that approves"
    echo "      EVERY tool call (file edits, shell commands, network access) in"
    echo "      EVERY Claude Code session on this machine, including sessions"
    echo "      that have nothing to do with Hive."
    echo "    - Claude Code will stop showing permission prompts anywhere."
    echo "    - It also blocks plan mode so agents execute directly, and it"
    echo "      delivers Hive inbox messages on Windows."
    echo ""
    echo "  Hive's unattended automation (auto-pilot, queued dispatch, satellite"
    echo "  messaging) depends on it. Without it, agents stall at permission"
    echo "  prompts until you approve them by hand."
    echo ""
    echo "  You can remove it at any time:"
    echo "    bash $REPO_ROOT/setup-hooks.sh --no-auto-approve"
    echo ""
    printf "  Install the machine-wide auto-approve hook? [Y/n] "
    read -r AUTO_APPROVE_REPLY || AUTO_APPROVE_REPLY=""
    case "$AUTO_APPROVE_REPLY" in
      n|N|no|NO|No) AUTO_APPROVE_MODE="off" ;;
      *)            AUTO_APPROVE_MODE="on" ;;
    esac
  else
    # Non-interactive (piped install, CI, agent-driven). Unattended automation
    # depends on the hook, so install it — but never silently: a loud notice
    # with the exact removal command prints below.
    AUTO_APPROVE_MODE="on"
  fi
fi

AUTO_APPROVE_ENABLED=0
[ "$AUTO_APPROVE_MODE" = "on" ] && AUTO_APPROVE_ENABLED=1

SETTINGS="$SETTINGS" \
IDENTITY_CMD="$IDENTITY_DST" \
AUTO_APPROVE_CMD="$AUTO_APPROVE_CMD" \
AUTO_APPROVE_ENABLED="$AUTO_APPROVE_ENABLED" \
DAEMON_URL="$DAEMON_URL" \
HIVE_TOKEN="$TOKEN" \
node <<'NODE'
const fs = require('fs');

const settingsPath = process.env.SETTINGS;
const identityCmd = process.env.IDENTITY_CMD;
const autoApproveCmd = process.env.AUTO_APPROVE_CMD;
const autoApproveEnabled = process.env.AUTO_APPROVE_ENABLED === '1';
const daemonUrl = process.env.DAEMON_URL;
const token = process.env.HIVE_TOKEN;
const authedHookUrl = `${daemonUrl}/hook?token=${token}`;

const raw = fs.readFileSync(settingsPath, 'utf-8');
const settings = raw.trim() ? JSON.parse(raw) : {};
const hooks = (settings.hooks && typeof settings.hooks === 'object') ? settings.hooks : {};

function ensureEntry(event) {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  let entry = entries.find((candidate) => (candidate?.matcher ?? '') === '');
  if (!entry) {
    entry = { matcher: '', hooks: [] };
    entries.push(entry);
  }
  if (!Array.isArray(entry.hooks)) {
    entry.hooks = [];
  }
  hooks[event] = entries;
  return entry;
}

function dedupeExact(entry) {
  const seen = new Set();
  entry.hooks = entry.hooks.filter((hook) => {
    const key = hook.type === 'http'
      ? `http:${hook.url || ''}`
      : `command:${hook.command || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function upsertHook(event, candidate, matchesLogicalHook) {
  const entry = ensureEntry(event);
  let replaced = false;
  const nextHooks = [];
  for (const hook of entry.hooks) {
    if (matchesLogicalHook(hook)) {
      if (!replaced) {
        nextHooks.push(candidate);
        replaced = true;
      }
      continue;
    }
    nextHooks.push(hook);
  }
  if (!replaced) {
    nextHooks.push(candidate);
  }
  entry.hooks = nextHooks;
  dedupeExact(entry);
}

const isHiveHttpHook = (hook) =>
  hook?.type === 'http' &&
  typeof hook.url === 'string' &&
  hook.url.startsWith(`${daemonUrl}/hook`);

const isIdentityHook = (hook) =>
  hook?.type === 'command' &&
  typeof hook.command === 'string' &&
  hook.command.includes('.hive/identity.sh');

const isAutoApproveHook = (hook) =>
  hook?.type === 'command' &&
  typeof hook.command === 'string' &&
  hook.command.includes('auto-approve.sh');

upsertHook('UserPromptSubmit', { type: 'command', command: identityCmd }, isIdentityHook);
upsertHook('UserPromptSubmit', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('Notification', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
if (autoApproveEnabled) {
  upsertHook('PreToolUse', { type: 'command', command: autoApproveCmd }, isAutoApproveHook);
} else {
  // Consent withdrawn or never given: strip any auto-approve hook.
  for (const entry of Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []) {
    if (Array.isArray(entry?.hooks)) {
      entry.hooks = entry.hooks.filter((hook) => !isAutoApproveHook(hook));
    }
  }
}
upsertHook('PreToolUse', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('PostToolUse', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('Stop', { type: 'http', url: authedHookUrl }, isHiveHttpHook);

settings.hooks = hooks;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log(`Updated ${settingsPath}`);
console.log('Installed Hive hooks for UserPromptSubmit, PreToolUse, PostToolUse, Notification, and Stop.');
console.log(`Identity hook: ${identityCmd}`);
if (autoApproveEnabled) {
  console.log(`Auto-approve hook: ${autoApproveCmd}`);
} else {
  console.log('Auto-approve hook: not installed (removed if previously present)');
}
NODE

# ── Auto-approve notice (always loud, never silent) ──────────────────

if [ "$AUTO_APPROVE_ENABLED" -eq 1 ]; then
  echo ""
  echo "  =============================================================="
  echo "  NOTICE: machine-wide auto-approve hook installed"
  echo ""
  echo "  ~/.claude/settings.json now has a PreToolUse hook that approves"
  echo "  EVERY tool call in EVERY Claude Code session on this machine."
  echo "  Claude Code will not show permission prompts anywhere, including"
  echo "  sessions that have nothing to do with Hive. Plan mode is blocked."
  echo ""
  echo "  Why: Hive's unattended agents (auto-pilot, queued dispatch,"
  echo "  satellite messaging on Windows) stall at permission prompts"
  echo "  without it."
  echo ""
  echo "  Remove it with this one line:"
  echo "  bash $REPO_ROOT/setup-hooks.sh --no-auto-approve"
  echo "  =============================================================="
  echo ""
else
  echo ""
  echo "  Auto-approve hook NOT installed (removed if previously present)."
  echo "  Claude Code permission prompts stay on. Hive's unattended"
  echo "  automation (auto-pilot, queued dispatch, Windows inbox delivery)"
  echo "  will stall at permission prompts until you approve them by hand."
  echo "  Enable later: bash $REPO_ROOT/setup-hooks.sh --auto-approve"
  echo ""
fi

# --- Install dispatch templates ---
# Copy CLAUDE.md and AGENTS.md templates so every agent knows
# how to discover peers and dispatch messages via the Hive API.

TEMPLATE_DIR="$REPO_ROOT/templates"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
AGENTS_MD="$HOME/AGENTS.md"

# CLAUDE.md: append Hive section if not already present
if [ -f "$TEMPLATE_DIR/CLAUDE.md" ]; then
  if [ ! -f "$CLAUDE_MD" ]; then
    cp "$TEMPLATE_DIR/CLAUDE.md" "$CLAUDE_MD"
    echo "Created $CLAUDE_MD with Hive dispatch docs"
  elif ! grep -q "Hive -- Multi-Agent Coordination" "$CLAUDE_MD" 2>/dev/null; then
    echo "" >> "$CLAUDE_MD"
    cat "$TEMPLATE_DIR/CLAUDE.md" >> "$CLAUDE_MD"
    echo "Appended Hive dispatch docs to $CLAUDE_MD"
  else
    echo "Hive dispatch docs already in $CLAUDE_MD"
  fi
fi

# AGENTS.md: for Codex and other agents that read ~/AGENTS.md
if [ -f "$TEMPLATE_DIR/AGENTS.md" ]; then
  if [ ! -f "$AGENTS_MD" ]; then
    cp "$TEMPLATE_DIR/AGENTS.md" "$AGENTS_MD"
    echo "Created $AGENTS_MD with Hive dispatch docs"
  elif ! grep -q "Hive -- Multi-Agent Coordination" "$AGENTS_MD" 2>/dev/null; then
    echo "" >> "$AGENTS_MD"
    cat "$TEMPLATE_DIR/AGENTS.md" >> "$AGENTS_MD"
    echo "Appended Hive dispatch docs to $AGENTS_MD"
  else
    echo "Hive dispatch docs already in $AGENTS_MD"
  fi
fi
