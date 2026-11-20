#!/usr/bin/env bash
# Tab Bridge on macOS / Linux: one command, safe to repeat.  bash start-bridge.sh
# Starts server.js (127.0.0.1:8765) in the background if no bridge answers /health, then waits for the Chrome extension.
cd "$(dirname "$0")" || exit 1
health() { curl -s --max-time 2 http://127.0.0.1:8765/health; }
# An old bridge (no "ws" field in /health) has no /ws endpoint: the extension gets 404, so it is replaced too.
is_new() { local h; h=$(health); echo "$h" | grep -q extConnected && echo "$h" | grep -q '"ws"'; }
if ! is_new; then
  # only an old copy of this bridge is replaced; another program on the port is never killed
  pid=$(lsof -ti tcp:8765 -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pid" ]; then
    health | grep -q extConnected || { echo "FAIL: port 8765 is used by another program (PID $pid). Close it, then run this again."; exit 1; }
    kill $pid 2>/dev/null && sleep 0.5
  fi
  nohup node server.js >bridge.log 2>bridge.err.log &
  for _ in $(seq 1 20); do sleep 0.3; is_new && break; done
  is_new || { echo "FAIL: bridge server did not start. See $(pwd)/bridge.err.log"; exit 1; }
  echo "Bridge server started on 127.0.0.1:8765"
fi
for _ in $(seq 1 40); do
  health | grep -q '"extConnected":true' && { echo "OK: Chrome extension connected."; exit 0; }
  sleep 1
done
echo "WARN: server is up but the Chrome extension is NOT connected."
echo " -> chrome://extensions -> Developer mode ON -> Load unpacked -> $(pwd)/ext (or reload 'Tab Bridge')."
exit 2
