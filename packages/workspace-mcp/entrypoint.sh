#!/bin/bash
set -e

# Start Xvfb with readiness check
Xvfb :99 -screen 0 1280x1024x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99
echo "[entrypoint] Waiting for Xvfb..."
while ! xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done
echo "[entrypoint] Xvfb ready"

# Start window manager
fluxbox -display :99 &
while ! pgrep -x fluxbox > /dev/null; do sleep 0.1; done
echo "[entrypoint] fluxbox ready"

if [ "${CLAWD_VNC_ENABLED:-false}" = "true" ]; then
  # x11vnc with no password — access is controlled by workspace token auth at the gateway level
  # Restart loop ensures VNC stays alive if it crashes
  (
    while true; do
      x11vnc -display :99 -forever -nopw -rfbport 5900 -quiet
      echo "[entrypoint] x11vnc exited, restarting..."
      sleep 1
    done
  ) &

  # Wait for x11vnc to be ready (max 30s)
  TRIES=0
  while ! netstat -ltn 2>/dev/null | grep -q ':5900' && ! (echo > /dev/tcp/localhost/5900) 2>/dev/null; do
    sleep 0.1
    TRIES=$((TRIES+1))
    [ $TRIES -ge 300 ] && { echo "[entrypoint] WARNING: x11vnc not ready after 30s"; break; }
  done

  # websockify with auto-restart — proxies noVNC WebSocket to VNC port 5900
  # --heartbeat=30: sends WebSocket ping every 30s to keep idle connections alive
  (
    while true; do
      websockify --web /usr/share/novnc --heartbeat=30 6080 localhost:5900
      echo "[entrypoint] websockify exited, restarting..."
      sleep 1
    done
  ) &

  echo "[entrypoint] VNC/noVNC enabled on :5900/:6080"
fi

echo "[entrypoint] Starting workspace MCP server..."
exec node /opt/workspace-mcp/dist/server.js
