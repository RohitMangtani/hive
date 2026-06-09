#!/bin/bash
# One-shot Hive install.
#
# Fresh instance:   bash scripts/install.sh
# Join existing:    bash scripts/install.sh --connect wss://URL TOKEN
# Non-interactive:  bash scripts/install.sh --fresh
#
# Consent for the machine-wide Claude Code auto-approve hook:
#   --auto-approve      install it without asking
#   --no-auto-approve   skip it (interactive runs ask if neither is given)
#
# With no flags, prompts the user to choose.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Pull the auto-approve consent flags out of the arg list before the
# positional parsing below. They can appear anywhere; the --connect
# positional contract (URL TOKEN) is unchanged.
POSITIONAL_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --auto-approve)    export HIVE_AUTO_APPROVE=1 ;;
    --no-auto-approve) export HIVE_AUTO_APPROVE=0 ;;
    *) POSITIONAL_ARGS+=("$arg") ;;
  esac
done
# bash 3.2 (macOS default) errors on empty-array expansion under set -u
set -- ${POSITIONAL_ARGS[@]+"${POSITIONAL_ARGS[@]}"}

IS_LINUX=0
IS_WSL=0
IS_GITBASH=0
UNAME_OUT="$(uname -s)"
case "$UNAME_OUT" in
  Linux*)
    IS_LINUX=1
    if grep -qi microsoft /proc/version 2>/dev/null; then
      IS_WSL=1
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash / MSYS2 / Cygwin on Windows — treat like Linux for most paths
    IS_LINUX=1
    IS_GITBASH=1
    ;;
esac

cleanup_hive_satellite_runtime() {
  mkdir -p "$HOME/.hive/runtime"

  if [ "$IS_GITBASH" -eq 1 ]; then
    # Git Bash / Windows cleanup — kill all satellite processes and remove Task Scheduler task
    powershell.exe -NoProfile -Command "Unregister-ScheduledTask -TaskName 'HiveSatellite' -Confirm:\$false -ErrorAction SilentlyContinue" 2>/dev/null || true
    # Kill any running satellite processes (including background ones from previous installs)
    powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match '--satellite' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
    # Also kill via PID file
    if [ -f "$HOME/.hive/runtime/satellite.pid" ]; then
      kill "$(cat "$HOME/.hive/runtime/satellite.pid")" 2>/dev/null || true
    fi
  elif [ "$IS_LINUX" -eq 1 ]; then
    # systemd cleanup
    systemctl --user stop hive-satellite.service 2>/dev/null || true
    systemctl --user disable hive-satellite.service 2>/dev/null || true
  else
    # macOS launchd cleanup
    mkdir -p "$HOME/Library/LaunchAgents"
    for plist in "$HOME/Library/LaunchAgents"/com.hive.satellite*.plist; do
      [ -e "$plist" ] || continue
      label="$(basename "$plist" .plist)"
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
      if [ "$plist" != "$HOME/Library/LaunchAgents/com.hive.satellite.plist" ]; then
        rm -f "$plist"
      fi
    done
  fi

  pkill -f 'apps/daemon/src/index.ts --satellite|dist/index.js --satellite' 2>/dev/null || true
  rm -f "$HOME/.hive/runtime/satellite.json"
}

# Direct cloudflared install for Linux without Homebrew: static binary
# from GitHub releases. Prefers /usr/local/bin (already on the daemon's
# runtime PATH); falls back to ~/.local/bin with a PATH warning, because
# tunnel auto-restart spawns "cloudflared" with the daemon's PATH.
install_cloudflared_linux() {
  local arch url tmp_bin target
  case "$(uname -m)" in
    x86_64|amd64)  arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "  ✗ No cloudflared build for architecture $(uname -m)."
      return 1
      ;;
  esac

  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  tmp_bin="$(mktemp)"
  echo "  Downloading cloudflared (linux-${arch}) from GitHub releases..."
  if ! curl -fsSL --retry 2 -o "$tmp_bin" "$url"; then
    rm -f "$tmp_bin"
    echo "  ✗ cloudflared download failed (network or GitHub unavailable)."
    return 1
  fi

  if [ -w /usr/local/bin ]; then
    target="/usr/local/bin/cloudflared"
    install -m 755 "$tmp_bin" "$target"
  elif sudo -n true 2>/dev/null; then
    target="/usr/local/bin/cloudflared"
    sudo -n install -m 755 "$tmp_bin" "$target"
  else
    mkdir -p "$HOME/.local/bin"
    target="$HOME/.local/bin/cloudflared"
    install -m 755 "$tmp_bin" "$target"
    export PATH="$HOME/.local/bin:$PATH"
    echo "  ⚠ Installed to ~/.local/bin (no sudo available)."
    echo "    Make sure ~/.local/bin is on PATH in your shell rc, or tunnel"
    echo "    auto-restarts after reboot will not find cloudflared:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  rm -f "$tmp_bin"
  echo "  ✓ cloudflared installed at $target"
}

ensure_tunnel_tools() {
  local have_ngrok=0
  local have_cloudflared=0

  if command -v ngrok &>/dev/null; then
    echo "  ✓ ngrok"
    have_ngrok=1
  fi

  if command -v cloudflared &>/dev/null; then
    echo "  ✓ cloudflared"
    have_cloudflared=1
  fi

  if [ "$have_ngrok" -eq 1 ] && [ "$have_cloudflared" -eq 0 ] && command -v brew &>/dev/null; then
    echo ""
    echo "  Installing cloudflared fallback (keeps hosted launch working if ngrok is unavailable)..."
    brew install cloudflared
    echo "  ✓ cloudflared installed"
    have_cloudflared=1
  fi

  if [ "$have_ngrok" -eq 0 ] && [ "$have_cloudflared" -eq 0 ]; then
    if command -v brew &>/dev/null; then
      echo ""
      echo "  Installing cloudflared (fallback tunnel for remote dashboard access)..."
      brew install cloudflared
      echo "  ✓ cloudflared installed"
      have_cloudflared=1
    elif [ "$IS_GITBASH" -eq 1 ]; then
      echo "  ✗ No public tunnel tool found."
      echo "    Install one in PowerShell and re-run:"
      echo "    winget install Cloudflare.cloudflared   (or: winget install ngrok.ngrok)"
      echo "    Or use: npm run launch:local  (localhost only, no remote access)"
      exit 1
    elif [ "$IS_LINUX" -eq 1 ]; then
      echo ""
      if install_cloudflared_linux; then
        have_cloudflared=1
      else
        echo "  ✗ No public tunnel tool found."
        echo "    Install ngrok or cloudflared manually and re-run:"
        echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        echo "    Or use: npm run launch:local  (localhost only, no remote access)"
        exit 1
      fi
    else
      echo "  ✗ No public tunnel tool found."
      echo "    Install Homebrew (https://brew.sh), ngrok, or cloudflared and re-run."
      echo "    Or use: npm run launch:local  (localhost only, no remote access)"
      exit 1
    fi
  fi
}

# ── Parse flags ──────────────────────────────────────────────────────

SATELLITE_MODE=0
PRIMARY_URL=""
PRIMARY_TOKEN=""

if [ "${1:-}" = "--connect" ]; then
  SATELLITE_MODE=1
  PRIMARY_URL="${2:-}"
  PRIMARY_TOKEN="${3:-}"

  if [ -z "$PRIMARY_URL" ] || [ -z "$PRIMARY_TOKEN" ]; then
    echo ""
    echo "  Usage: bash scripts/install.sh --connect <tunnel-url> <token>"
    echo ""
    echo "  Get these from your primary Hive dashboard (the machine"
    echo "  that's already running Hive)."
    echo ""
    exit 1
  fi

  PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"

elif [ "${1:-}" = "--fresh" ]; then
  SATELLITE_MODE=0

elif [ -t 0 ]; then
  # Interactive terminal: ask the user what they want
  echo ""
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │             Hive Setup                   │"
  echo "  │                                          │"
  echo "  │  1) New environment                      │"
  echo "  │     Start fresh with your own dashboard  │"
  echo "  │                                          │"
  echo "  │  2) Join a Hive network                  │"
  echo "  │     Connect this computer's terminals    │"
  echo "  │     to an existing Hive running on       │"
  echo "  │     another machine                      │"
  echo "  │                                          │"
  echo "  └─────────────────────────────────────────┘"
  echo ""
  printf "  Choose (1 or 2): "
  read -r CHOICE

  if [ "$CHOICE" = "2" ]; then
    SATELLITE_MODE=1
    echo ""
    printf "  Tunnel URL (wss://... from primary dashboard): "
    read -r PRIMARY_URL
    printf "  Token (from primary dashboard): "
    read -r PRIMARY_TOKEN

    if [ -z "$PRIMARY_URL" ] || [ -z "$PRIMARY_TOKEN" ]; then
      echo ""
      echo "  Both URL and token are required."
      exit 1
    fi

    PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"
  fi
else
  # Non-interactive (piped from Claude Code, CI, etc.)
  # Check environment variables for satellite mode
  if [ -n "${HIVE_PRIMARY_URL:-}" ] && [ -n "${HIVE_PRIMARY_TOKEN:-}" ]; then
    SATELLITE_MODE=1
    PRIMARY_URL="${HIVE_PRIMARY_URL}"
    PRIMARY_TOKEN="${HIVE_PRIMARY_TOKEN}"
    PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"
  else
    SATELLITE_MODE=0
    echo "  ┌──────────────────────────────────────────────────────┐"
    echo "  │  Running in non-interactive mode → fresh install.    │"
    echo "  │                                                      │"
    echo "  │  To join an existing Hive network instead, re-run:   │"
    echo "  │  bash scripts/install.sh --connect <URL> <TOKEN>     │"
    echo "  │                                                      │"
    echo "  │  Or set env vars before running:                     │"
    echo "  │  HIVE_PRIMARY_URL=wss://... HIVE_PRIMARY_TOKEN=...   │"
    echo "  └──────────────────────────────────────────────────────┘"
  fi
fi

echo ""
if [ "$SATELLITE_MODE" -eq 1 ]; then
  echo "  Connecting to Hive network..."
else
  echo "  Installing Hive..."
fi
echo ""

# ── 1. Setup ──────────────────────────────────────────────────────────

# The satellite flow must run unattended (LOCKED): never block on the
# auto-approve consent prompt. With no explicit flag, install the hook —
# setup-hooks.sh prints the loud notice + removal command either way.
if [ "$SATELLITE_MODE" -eq 1 ] && [ -z "${HIVE_AUTO_APPROVE:-}" ]; then
  export HIVE_AUTO_APPROVE=1
fi

# setup.sh is idempotent (token generation is guarded, hooks merge/upsert,
# send-return compile is skipped when present), so always run it. Gating on
# ~/.hive/token skipped hooks/identity/send-return forever when the token
# was created by another path (satellite join, daemon, manual).
bash "$ROOT/setup.sh"

# ── Satellite: store config + start ───────────────────────────────────

if [ "$SATELLITE_MODE" -eq 1 ]; then
  # Store primary connection info
  mkdir -p "$HOME/.hive"
  echo "$PRIMARY_URL" > "$HOME/.hive/primary-url"
  {
    echo "$PRIMARY_URL"
    [ -f "$HOME/.hive/primary-urls.txt" ] && cat "$HOME/.hive/primary-urls.txt"
  } | awk 'NF && !seen[$0]++' | head -5 > "$HOME/.hive/primary-urls.txt"
  echo "$PRIMARY_TOKEN" > "$HOME/.hive/primary-token"
  if ! chmod 600 "$HOME/.hive/primary-url" "$HOME/.hive/primary-urls.txt" "$HOME/.hive/primary-token" 2>/dev/null; then
    echo "  ⚠ Could not restrict token file permissions — they may be world-readable"
  fi
  echo "  ✓ Primary connection stored"

  echo "  Cleaning existing Hive satellite runtime..."
  cleanup_hive_satellite_runtime

  # Stop any existing daemon on port 3001
  check_port_3001() {
    if [ "$IS_GITBASH" -eq 1 ]; then
      powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue" 2>/dev/null | grep -q "Listen" || return 1
    elif [ "$IS_LINUX" -eq 1 ]; then
      ss -tlnp 2>/dev/null | grep -q ':3001 ' || return 1
    else
      lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 || return 1
    fi
  }

  if check_port_3001; then
    echo "  Stopping existing daemon on :3001..."
    if [ "$IS_GITBASH" -eq 1 ]; then
      powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
    elif [ "$IS_LINUX" -eq 1 ]; then
      fuser -k 3001/tcp 2>/dev/null || true
    else
      # xargs handles multiple listener PIDs; a quoted $() would pass them
      # as one newline-embedded argument and kill would fail
      lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
    fi
    sleep 2
  fi

  # Find npx/node paths for the service
  NPX_PATH="$(which npx 2>/dev/null || echo '/usr/local/bin/npx')"
  NODE_DIR="$(dirname "$(which node 2>/dev/null || echo '/usr/local/bin/node')")"
  mkdir -p "$HOME/.hive/logs"

  if [ "$IS_GITBASH" -eq 1 ]; then
    # ── Git Bash / MSYS2 on Windows ─────────────────────────────────
    echo "  Windows (Git Bash) detected..."

    # Convert MSYS paths to Windows paths
    WIN_ROOT="$(cygpath -w "$ROOT" 2>/dev/null || echo "$ROOT")"
    WIN_HIVE_DIR="$(cygpath -w "$HOME/.hive" 2>/dev/null || echo "$HOME/.hive")"
    WIN_NPX="$(cygpath -w "$(which npx 2>/dev/null)" 2>/dev/null || echo "npx")"

    # Write a batch file for the satellite with an infinite restart loop.
    # This ensures the process always comes back regardless of exit code.
    BAT_FILE="$HOME/.hive/satellite.bat"
    cat > "$BAT_FILE" <<BATEOF
@echo off
cd /d "${WIN_ROOT}"
:loop
"${WIN_NPX}" tsx apps/daemon/src/index.ts --satellite >> "${WIN_HIVE_DIR}\\logs\\satellite.stdout.log" 2>> "${WIN_HIVE_DIR}\\logs\\satellite.stderr.log"
echo [%date% %time%] Satellite exited with code %ERRORLEVEL%, restarting in 5s... >> "${WIN_HIVE_DIR}\\logs\\satellite.stderr.log"
timeout /t 5 /nobreak >nul
goto loop
BATEOF

    # Register Task Scheduler task via PowerShell for permanent auto-restart.
    # Try elevated first (AtStartup + AtLogOn), fall back to user-level (AtLogOn only).
    WIN_BAT="$(cygpath -w "$BAT_FILE" 2>/dev/null || echo "$BAT_FILE")"
    echo "  Registering Windows Task Scheduler task..."
    TASK_OK=0

    # Attempt 1: elevated (AtStartup + AtLogOn)
    if powershell.exe -NoProfile -Command "
      \$action = New-ScheduledTaskAction -Execute '$WIN_BAT' -WorkingDirectory '$WIN_ROOT'
      \$t1 = New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME
      \$t2 = New-ScheduledTaskTrigger -AtStartup
      \$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365) -StartWhenAvailable
      Register-ScheduledTask -TaskName 'HiveSatellite' -Action \$action -Trigger @(\$t1, \$t2) -Settings \$settings -Description 'Hive Satellite Daemon' -RunLevel Highest -Force | Out-Null
      Start-ScheduledTask -TaskName 'HiveSatellite'
    " 2>/dev/null; then
      TASK_OK=1
      echo "  ✓ Satellite service installed (Task Scheduler, elevated)"
    else
      # Attempt 2: user-level (AtLogOn only, no admin needed)
      if powershell.exe -NoProfile -Command "
        \$action = New-ScheduledTaskAction -Execute '$WIN_BAT' -WorkingDirectory '$WIN_ROOT'
        \$t1 = New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME
        \$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365) -StartWhenAvailable
        Register-ScheduledTask -TaskName 'HiveSatellite' -Action \$action -Trigger \$t1 -Settings \$settings -Description 'Hive Satellite Daemon' -Force | Out-Null
        Start-ScheduledTask -TaskName 'HiveSatellite'
      " 2>/dev/null; then
        TASK_OK=1
        echo "  ✓ Satellite service installed (Task Scheduler, user-level)"
      fi
    fi

    if [ "$TASK_OK" -eq 0 ]; then
      # Fallback: Startup folder + background process
      STARTUP_DIR="$(cygpath "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup" 2>/dev/null || echo "")"
      if [ -n "$STARTUP_DIR" ] && [ -d "$STARTUP_DIR" ]; then
        cp "$BAT_FILE" "$STARTUP_DIR/hive-satellite.bat"
        echo "  ✓ Auto-start on login (Windows Startup folder fallback)"
      fi

      echo "  Starting satellite..."
      "$NPX_PATH" tsx apps/daemon/src/index.ts --satellite \
        > "$HOME/.hive/logs/satellite.stdout.log" \
        2> "$HOME/.hive/logs/satellite.stderr.log" &
      BGPID=$!
      echo "$BGPID" > "$HOME/.hive/runtime/satellite.pid"
      disown "$BGPID" 2>/dev/null || true
    fi

  elif [ "$IS_LINUX" -eq 1 ]; then
    # ── Linux / WSL: systemd user service ────────────────────────────
    CURRENT_PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin"

    # Ensure tmux is installed (Linux platform uses tmux for terminal IO)
    if ! command -v tmux &>/dev/null; then
      echo "  Installing tmux (required for terminal management on Linux)..."
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y tmux 2>/dev/null || true
      elif command -v yum &>/dev/null; then
        sudo yum install -y tmux 2>/dev/null || true
      fi
    fi
    if command -v tmux &>/dev/null; then
      echo "  ✓ tmux"
    else
      echo "  ⚠ tmux not found — install manually for terminal management"
    fi

    # Check if systemd is available (real Linux or WSL2 with systemd)
    HAS_SYSTEMD=0
    if command -v systemctl &>/dev/null && systemctl --user status 2>/dev/null | head -1 | grep -q "State:"; then
      HAS_SYSTEMD=1
    fi

    if [ "$HAS_SYSTEMD" -eq 1 ]; then
      mkdir -p "$HOME/.config/systemd/user"
      cat > "$HOME/.config/systemd/user/hive-satellite.service" <<UNIT
[Unit]
Description=Hive Satellite Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PATH=$CURRENT_PATH
Environment=HOME=$HOME
ExecStart=$NPX_PATH tsx apps/daemon/src/index.ts --satellite
Restart=always
RestartSec=5
StandardOutput=append:$HOME/.hive/logs/satellite.stdout.log
StandardError=append:$HOME/.hive/logs/satellite.stderr.log

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable hive-satellite.service
      systemctl --user restart hive-satellite.service
      echo "  ✓ Satellite service installed (systemd user service)"

      # Enable lingering so the service runs even when not logged in
      loginctl enable-linger "$(whoami)" 2>/dev/null || true
    else
      # No systemd (WSL1 or minimal container) — use nohup fallback
      echo "  No systemd available — starting satellite in background..."
      nohup "$NPX_PATH" tsx apps/daemon/src/index.ts --satellite \
        > "$HOME/.hive/logs/satellite.stdout.log" \
        2> "$HOME/.hive/logs/satellite.stderr.log" &
      echo $! > "$HOME/.hive/runtime/satellite.pid"
      disown "$!" 2>/dev/null || true
      echo "  ✓ Satellite started (PID $(cat "$HOME/.hive/runtime/satellite.pid"))"
      echo "  ⚠ No systemd — satellite won't auto-start on reboot."
      echo "    Add to ~/.bashrc or crontab:"
      echo "    @reboot cd $ROOT && $NPX_PATH tsx apps/daemon/src/index.ts --satellite"
    fi
  else
    # ── macOS: launchd plist ─────────────────────────────────────────
    launchctl bootout "gui/$(id -u)/com.hive.satellite" 2>/dev/null || true
    CURRENT_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$HOME/Library/LaunchAgents/com.hive.satellite.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hive.satellite</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT' &amp;&amp; '$NPX_PATH' tsx apps/daemon/src/index.ts --satellite</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$CURRENT_PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.hive/logs/satellite.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.hive/logs/satellite.stderr.log</string>
</dict>
</plist>
PLIST
    echo "  ✓ Satellite service installed (com.hive.satellite)"

    # Start the service (try modern API first, fall back to legacy)
    if ! launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hive.satellite.plist" 2>/dev/null; then
      launchctl load "$HOME/Library/LaunchAgents/com.hive.satellite.plist" 2>/dev/null
    fi
  fi

  # Wait for satellite to start (platform-agnostic)
  SAT_OK=0
  for _ in $(seq 1 15); do
    if check_port_3001; then
      SAT_OK=1
      break
    fi
    sleep 1
  done

  if [ "$SAT_OK" -eq 1 ]; then
    echo "  ✓ Satellite daemon running"
  else
    echo "  ✗ Satellite daemon failed to start."
    echo "    Log: cat ~/.hive/logs/satellite.stderr.log"
    echo ""
    tail -10 "$HOME/.hive/logs/satellite.stderr.log" 2>/dev/null | sed 's/^/    /'
    exit 1
  fi

  # GPU detection report (useful for routing tasks to GPU machines)
  if command -v nvidia-smi &>/dev/null; then
    GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "")"
    GPU_VRAM="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "")"
    if [ -n "$GPU_NAME" ]; then
      echo "  ✓ GPU detected: $GPU_NAME (${GPU_VRAM}MB)"
      echo "    Tasks with \"requires\":[\"gpu\"] will route here."
    fi
  fi

  echo ""
  echo "  ────────────────────────────────────────────────"
  echo ""
  echo "  Connected to Hive network."
  echo ""
  echo "  Primary: $PRIMARY_URL"
  echo ""
  echo "  Your terminals will appear on the primary's"
  echo "  dashboard within a few seconds."
  echo ""
  if [ "$IS_GITBASH" -eq 1 ]; then
    echo "  Open terminal windows and run 'claude', 'codex',"
    echo "  or any agent — the primary dashboard sees them."
  elif [ "$IS_LINUX" -eq 1 ]; then
    echo "  Open tmux panes and run 'claude', 'codex',"
    echo "  or any agent — the primary dashboard sees them."
    echo "  (Hive uses tmux for terminal management on Linux.)"
  else
    echo "  Open Terminal windows and run 'claude', 'codex',"
    echo "  or any agent — the primary dashboard sees them."
  fi
  echo ""
  echo "  The satellite runs as a background service."
  echo "  It survives sleep, reboot, and terminal close."
  echo "  Agents disappear from the dashboard when this"
  echo "  computer is off and reappear when it wakes."
  echo ""
  if [ "$IS_LINUX" -eq 0 ] && [ "$IS_GITBASH" -eq 0 ]; then
    echo "  ⚠  If macOS asks you to approve Node.js in"
    echo "     System Settings → Privacy & Security,"
    echo "     click Allow. This is a one-time approval"
    echo "     so the background service can run."
    echo ""
  fi
  echo "  Log:   cat ~/.hive/logs/satellite.stderr.log"
  if [ "$IS_GITBASH" -eq 1 ]; then
    echo "  Stop:  kill \$(cat ~/.hive/runtime/satellite.pid)"
  elif [ "$IS_LINUX" -eq 1 ] && [ "${HAS_SYSTEMD:-0}" -eq 1 ]; then
    echo "  Stop:  systemctl --user stop hive-satellite"
  elif [ "$IS_LINUX" -eq 0 ]; then
    echo "  Stop:  launchctl bootout gui/$(id -u)/com.hive.satellite"
  fi
  echo ""
  echo "  ────────────────────────────────────────────────"
  echo ""
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════
# Primary mode (default) — unchanged from original install flow
# ══════════════════════════════════════════════════════════════════════

# ── 2. Tunnel tooling ────────────────────────────────────────────────

ensure_tunnel_tools

# ── 3. Vercel login ──────────────────────────────────────────────────

if ! npx vercel whoami >/dev/null 2>&1; then
  echo ""
  echo "  Logging into Vercel (this opens your browser — click authorize)..."
  npx vercel login
fi
echo "  ✓ Vercel authenticated"

# ── 4. Start daemon + tunnel ──────────────────────────────────────────

DAEMON_START_MODE="existing"

if lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  ✓ Daemon already running on :3001"
else
  echo ""
  echo "  Starting daemon + tunnel..."
  # Start in a new Terminal window so the daemon runs as a Terminal.app
  # child process. This is required for osascript Automation permission
  # (closing terminals from the dashboard). macOS may show an approval
  # dialog the first time — click OK.
  # Escape single quotes in ROOT for safe embedding in AppleScript string
  ESCAPED_ROOT="${ROOT//\'/\'\\\'\'}"
  if osascript -e "tell application \"Terminal\" to do script \"cd '${ESCAPED_ROOT}' && npm start\"" 2>/dev/null; then
    echo "  ✓ Daemon started in a new Terminal window"
    DAEMON_START_MODE="terminal_window"
  else
    # Fallback: background process (X button won't close terminal windows)
    echo "  Could not open Terminal window — starting in background..."
    nohup npm start > "$HOME/.hive/daemon.log" 2>&1 &
    disown "$!" 2>/dev/null || true
    echo "  ✓ Daemon started in background (log: ~/.hive/daemon.log)"
    DAEMON_START_MODE="background"
  fi
fi

# ── 5. Wait for tunnel URL ───────────────────────────────────────────

echo "  Waiting for tunnel..."
TUNNEL_URL=""
for _ in $(seq 1 90); do
  if [ -f "$HOME/.hive/tunnel-url.txt" ]; then
    TUNNEL_URL="$(grep -Eo 'https://[^[:space:]]+' "$HOME/.hive/tunnel-url.txt" | head -1 || true)"
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "  ✗ Timed out waiting for tunnel."
  if [ "$DAEMON_START_MODE" = "terminal_window" ]; then
    echo "    Check the Terminal window Hive opened for daemon output."
  elif [ "$DAEMON_START_MODE" = "background" ]; then
    echo "    Check ~/.hive/daemon.log for daemon output."
  fi
  echo "    Tunnel logs: ~/.hive/ngrok.log or ~/.hive/cloudflared.log"
  exit 1
fi
echo "  ✓ Tunnel ready"

# ── 5b. Primary persistence (macOS launchd) ──────────────────────────
# identity.sh and auto-update already reference com.hive.daemon; install
# the plist so the primary survives reboots like satellites do. Mirrors
# the satellite plist (KeepAlive + RunAtLoad), with one addition: the
# command waits while another daemon owns :3001 instead of crash-looping
# on EADDRINUSE, so it coexists with a Terminal-window daemon and takes
# over when that daemon stops.
DAEMON_PERSISTENCE=0
if [ "$IS_LINUX" -eq 0 ] && [ "$IS_GITBASH" -eq 0 ]; then
  NODE_DIR="$(dirname "$(which node 2>/dev/null || echo '/usr/local/bin/node')")"
  DAEMON_PATH_ENV="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.hive/logs"
  cat > "$HOME/Library/LaunchAgents/com.hive.daemon.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hive.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT' &amp;&amp; while lsof -tiTCP:3001 -sTCP:LISTEN &gt;/dev/null 2&gt;&amp;1; do sleep 30; done; exec npm start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$DAEMON_PATH_ENV</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.hive/logs/daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.hive/logs/daemon.stderr.log</string>
</dict>
</plist>
PLIST
  # Only bootstrap if the label is not already loaded — booting out a
  # live launchd-managed daemon mid-install would restart it for nothing.
  if ! launchctl print "gui/$(id -u)/com.hive.daemon" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hive.daemon.plist" 2>/dev/null \
      || launchctl load "$HOME/Library/LaunchAgents/com.hive.daemon.plist" 2>/dev/null || true
  fi
  DAEMON_PERSISTENCE=1
  echo "  ✓ Installed launchd persistence (com.hive.daemon)"
  echo "    The primary daemon now auto-starts at login and restarts if it dies."
  echo "    Remove: launchctl bootout gui/$(id -u)/com.hive.daemon; rm ~/Library/LaunchAgents/com.hive.daemon.plist"
fi

# ── 6. Deploy dashboard ──────────────────────────────────────────────

echo ""
echo "  Deploying dashboard to Vercel..."
npm run deploy:dashboard

# ── 7. Done ───────────────────────────────────────────────────────────

TOKEN="$(cat "$HOME/.hive/token" 2>/dev/null || echo '(not found)')"
DASHBOARD_URL="$(grep -Eo 'https://[[:alnum:].-]+\.vercel\.app' "$HOME/.hive/dashboard-url.txt" 2>/dev/null | tail -1 || echo '(check deploy output above)')"
WS_URL="${TUNNEL_URL/https:\/\//wss://}"

echo ""
echo "  ────────────────────────────────────────────────"
echo ""
echo "  Hive is installed and running."
echo ""
echo "  Dashboard: $DASHBOARD_URL"
echo "  Token:     $TOKEN"
echo ""
echo "  Open the dashboard, paste your token, and start"
echo "  running agents in Terminal windows."
echo ""
if [ "$DAEMON_START_MODE" = "terminal_window" ]; then
  echo "  The daemon is running in a separate Terminal window."
  if [ "$DAEMON_PERSISTENCE" -eq 1 ]; then
    echo "  If you close it (or reboot), launchd restarts the daemon"
    echo "  automatically (com.hive.daemon)."
  else
    echo "  Keep that window open while Hive is running."
  fi
  echo ""
elif [ "$DAEMON_START_MODE" = "background" ]; then
  echo "  The daemon is running in the background."
  echo "  Log: ~/.hive/daemon.log"
  echo ""
else
  echo "  The daemon was already running on :3001."
  echo ""
fi
echo "  ── Connect another machine ──"
echo ""
echo "  On the other computer, clone Hive and run:"
echo ""
echo "  git clone https://github.com/RohitMangtani/hive.git"
echo "  cd hive"
echo ""
echo "  macOS / Linux:"
echo "  bash scripts/install.sh --connect $WS_URL $TOKEN"
echo ""
echo "  Windows (PowerShell):"
echo "  .\\scripts\\install.ps1 -Connect -Url $WS_URL -Token $TOKEN"
echo ""
echo "  Or paste this into Claude Code / Codex on the other machine:"
echo ""
echo "  Install Hive for me. Clone https://github.com/RohitMangtani/hive."
echo "  Then run: bash scripts/install.sh --connect $WS_URL $TOKEN"
echo "  Give me whatever it prints at the end."
echo ""
echo "  Connection is permanent. The satellite runs as a"
echo "  background service and survives sleep and reboot."
echo ""
echo "  To get this invite again later: npm run invite"
echo ""
echo "  Tunnel logs: ~/.hive/ngrok.log or ~/.hive/cloudflared.log"
if [ "$DAEMON_PERSISTENCE" -eq 1 ]; then
  echo "  Stop: launchctl bootout gui/$(id -u)/com.hive.daemon"
  echo "        then: lsof -tiTCP:3001 -sTCP:LISTEN | xargs kill"
elif [ "$IS_LINUX" -eq 1 ] && [ "$IS_GITBASH" -eq 0 ]; then
  echo "  Stop: fuser -k 3001/tcp"
else
  # -sTCP:LISTEN targets only the daemon; without it this would also
  # kill clients merely connected to :3001 (curl, browser helpers)
  echo "  Stop: lsof -tiTCP:3001 -sTCP:LISTEN | xargs kill"
fi
echo ""
echo "  ────────────────────────────────────────────────"
echo ""
