#!/bin/bash
set -e

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PROJECT_DIR="$HOME/propcall-ai"
NGROK_BIN="$HOME/.local/bin/ngrok"
DOMAIN="grasp-prevalent-exorcist.ngrok-free.dev"
LOGDIR="$HOME/Library/Logs/propcall-ai"
mkdir -p "$LOGDIR"

if ! /usr/local/bin/docker info >/dev/null 2>&1; then
  open -a Docker
  for i in $(seq 1 60); do
    /usr/local/bin/docker info >/dev/null 2>&1 && break
    sleep 2
  done
fi

if ! /usr/local/bin/docker info >/dev/null 2>&1; then
  echo "Docker did not start in time. Open Docker Desktop manually and try again." >&2
  exit 1
fi

cd "$PROJECT_DIR"
/usr/local/bin/docker-compose up -d

if ! pgrep -f "ngrok http" >/dev/null 2>&1; then
  nohup "$NGROK_BIN" http --url="$DOMAIN" 3000 --log=stdout > "$LOGDIR/ngrok.log" 2>&1 &
  disown
  sleep 3
fi

echo "https://$DOMAIN"
