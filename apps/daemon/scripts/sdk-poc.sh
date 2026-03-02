#!/bin/bash
# Proof of concept: spawn Claude Code as a subprocess with streaming JSON
# This simulates what the daemon would do instead of AppleScript + CGEvent
#
# Run this OUTSIDE of a Claude Code session (from a plain terminal)

unset CLAUDECODE  # bypass nesting guard if needed

echo "=== Spawning Claude Code as subprocess ==="
echo "What directory am I in? List the files." | claude -p \
  --output-format stream-json \
  --no-session-persistence \
  --max-turns 2 \
  --cwd ~/factory/projects/hive 2>&1

echo ""
echo "=== Done ==="
