#!/bin/bash
set -e

# Start Xvfb with readiness check
Xvfb :99 -screen 0 1280x1024x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99
echo "[entrypoint] Waiting for Xvfb..."
while ! xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done
echo "[entrypoint] Xvfb ready"

# Start window manager and wait for it
fluxbox -display :99 &
while ! pgrep -x fluxbox > /dev/null; do sleep 0.1; done
echo "[entrypoint] fluxbox ready"

# VNC with secure random password (not logged — retrieve from container secret mount)
VNC_PASSWORD=$(cat /run/secrets/vnc_password 2>/dev/null || openssl rand -base64 16)
mkdir -p /tmp/vnc
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc/vncpass
chmod 600 /tmp/vnc/vncpass
unset VNC_PASSWORD  # Clear from env immediately

if [ "${CLAWD_VNC_ENABLED:-false}" = "true" ]; then
  # Start VNC services in background — do NOT block MCP server startup
  (
    x11vnc -display :99 -forever -rfbauth /tmp/vnc/vncpass -rfbport 5900 -bg -quiet
    # Wait for x11vnc with a timeout (max 30s) before starting websockify
    TRIES=0
    while [ $TRIES -lt 300 ]; do
      if nc -z localhost 5900 2>/dev/null || \
         (cat /dev/tcp/localhost/5900 2>/dev/null && echo "" >/dev/null) || \
         ss -ltn 2>/dev/null | grep -q ':5900'; then
        break
      fi
      sleep 0.1
      TRIES=$((TRIES+1))
    done
    websockify --web /usr/share/novnc 6080 localhost:5900 &
    echo "[entrypoint] VNC/noVNC enabled on :5900/:6080"
  ) &
fi

echo "[entrypoint] Starting workspace MCP server..."
exec node /opt/workspace-mcp/dist/server.js
