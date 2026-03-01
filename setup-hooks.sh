#!/bin/bash
# One-time setup: adds Claude Code hooks that POST live tool events to the Hive daemon.
# Run: bash setup-hooks.sh

SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo "Error: $SETTINGS not found"
  exit 1
fi

# Check if hooks already configured
if grep -q '"hooks"' "$SETTINGS" 2>/dev/null; then
  echo "hooks key already exists in $SETTINGS"
  echo "Please manually merge the hook config. See below:"
  echo ""
  cat <<'HOOKJSON'
Add these to your existing "hooks" object:

"PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1" }] }],
"PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1" }] }],
"Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1" }] }],
"Stop": [{ "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:3001/hook -H 'Content-Type: application/json' -d @- > /dev/null 2>&1" }] }]
HOOKJSON
  exit 0
fi

# Add hooks to settings.json using node (safe JSON manipulation)
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));
const hook = { type: 'command', command: 'curl -s -X POST http://localhost:3001/hook -H \"Content-Type: application/json\" -d @- > /dev/null 2>&1' };
settings.hooks = {
  PreToolUse: [{ matcher: '', hooks: [hook] }],
  PostToolUse: [{ matcher: '', hooks: [hook] }],
  Notification: [{ matcher: '', hooks: [hook] }],
  Stop: [{ hooks: [hook] }]
};
fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2) + '\n');
console.log('Hooks added to ' + '$SETTINGS');
console.log('Events: PreToolUse, PostToolUse, Notification, Stop');
console.log('All Claude Code instances will now report live events to Hive.');
"
