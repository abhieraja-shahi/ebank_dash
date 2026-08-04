#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$DIR"

echo "==> Pulling latest code"
git pull

echo "==> Ensuring backend/.env exists"
if [ ! -f backend/.env ]; then
  echo "ERROR: backend/.env not found. Copy backend/.env.example and fill in credentials."
  exit 1
fi

echo "==> Building images"
$COMPOSE build --pull

echo "==> Restarting services"
$COMPOSE up -d --remove-orphans

echo "==> Status"
$COMPOSE ps

echo ""
echo "Done. Dashboard is at http://$(hostname -I | awk '{print $1}')"
