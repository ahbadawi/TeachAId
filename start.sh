#!/usr/bin/env bash
# TeachAId — start all servers
#
# Usage:
#   bash start.sh           # development (Vite dev + Express + optional local TTS/STT)
#   bash start.sh prod      # production  (built dist served by Express on single port)

set -e
cd "$(dirname "$0")"

export PATH="/tmp/node-v22.14.0-darwin-arm64/bin:$PATH"
MODE="${1:-dev}"

echo "── Starting XTTS-V2 TTS server (port 3002, optional)…"
nohup python3 tts_server.py > /tmp/tts-server.log 2>&1 &
echo "   (logs: /tmp/tts-server.log)"

echo "── Starting Faster Whisper STT server (port 3003, optional)…"
nohup python3 whisper_server.py > /tmp/whisper-server.log 2>&1 &
echo "   (logs: /tmp/whisper-server.log)"

if [ "$MODE" = "prod" ]; then
  echo "── Building Vite frontend…"
  node node_modules/.bin/vite build

  echo "── Starting Express API + static server (port ${PORT:-8080})…"
  nohup npx tsx server.ts > /tmp/api-server.log 2>&1 &
  echo "   (logs: /tmp/api-server.log)"
  echo ""
  echo "Production server on port ${PORT:-8080}. Set APP_URL to your HTTPS domain."
  echo "To stop:  pkill -f 'tts_server\|whisper_server\|tsx server'"
else
  echo "── Starting Express API server (port 3001)…"
  nohup npx tsx server.ts > /tmp/api-server.log 2>&1 &
  echo "   (logs: /tmp/api-server.log)"

  echo "── Starting Vite frontend (port 3000)…"
  nohup node node_modules/.bin/vite --port=3000 --host=0.0.0.0 > /tmp/vite.log 2>&1 &
  echo "   (logs: /tmp/vite.log)"

  echo ""
  echo "App:     http://localhost:3000"
  echo "API:     http://localhost:3001/api/health"
  echo "To stop: pkill -f 'tts_server\|whisper_server\|tsx server\|vite'"
fi
