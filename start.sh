#!/usr/bin/env bash
# SentryAI MVP — starts the classification service + ingestion API together.
# Usage: ./start.sh
# Stop with Ctrl+C (the trap below cleans up both background processes).

set -euo pipefail
cd "$(dirname "$0")"

echo "Starting classification service (Python/Flask) on :5001 ..."
(cd classification-service && python3 app.py) &
CLASSIFY_PID=$!

echo "Starting ingestion API (Node.js) on :3000 ..."
(cd api && node src/server.js) &
API_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$CLASSIFY_PID" "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo ""
echo "SentryAI MVP is running:"
echo "  Dashboard:   http://127.0.0.1:3000/"
echo "  API health:  http://127.0.0.1:3000/health"
echo "  Classifier:  http://127.0.0.1:5001/health"
echo ""
echo "Next: load the extension/ folder as an unpacked Chrome extension"
echo "(chrome://extensions -> Developer mode -> Load unpacked)."
echo ""
echo "Press Ctrl+C to stop."

wait
