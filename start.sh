#!/usr/bin/env bash
set -euo pipefail
# Run this in WSL (Ubuntu). Assumes ffmpeg is installed in WSL and node>=18 installed.
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "Working dir: $ROOT"

# Install node modules if missing
if [ ! -d node_modules ]; then
  echo "Installing npm packages (may build mediasoup native)..."
  npm ci
fi

# ensure logs & media directories
mkdir -p logs media public

# Start server (keep logs)
echo "Starting server (logs/server.log). Ctrl-C to stop."
nohup node server.js >> logs/server.log 2>&1 &

echo "Server started. Tail logs with: tail -f logs/server.log"
tail -f logs/server.log
