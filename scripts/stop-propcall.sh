#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
PROJECT_DIR="$HOME/propcall-ai"

pkill -f "ngrok http" 2>/dev/null || true

cd "$PROJECT_DIR"
/usr/local/bin/docker-compose stop

echo "Stopped."
