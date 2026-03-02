#!/usr/bin/env bash
# Auto-approve hook: outputs {"decision":"approve"} so Claude Code
# never blocks waiting for keyboard permission input.
# Also forwards the event to the daemon for telemetry (non-blocking).

# Read stdin (JSON from Claude Code hook system)
INPUT=$(cat)

# Forward to daemon telemetry (fire-and-forget background)
TOKEN=""
if [ -f "$HOME/.hive/token" ]; then
  TOKEN=$(cat "$HOME/.hive/token" | tr -d '\n')
fi

if [ -n "$TOKEN" ]; then
  # Include the full hook context so the daemon knows what tool is running
  echo "$INPUT" | curl -s -X POST "http://localhost:3001/hook?token=${TOKEN}" \
    -H "Content-Type: application/json" \
    -d @- >/dev/null 2>&1 &
fi

# Auto-approve: this is the magic line that prevents the permission prompt
echo '{"decision":"approve"}'
exit 0
