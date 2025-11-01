#!/bin/bash
# Wait for PostgreSQL to be ready
# Usage: ./wait-for-postgres.sh [host] [port] [user] [timeout]
# Environment variables: PGHOST, PGPORT, PGUSER (defaults if not provided)

HOST="${1:-${PGHOST:-localhost}}"
PORT="${2:-${PGPORT:-5432}}"
USER="${3:-${PGUSER:-postgres}}"
TIMEOUT="${4:-60}"

echo "Waiting for PostgreSQL at $HOST:$PORT (user: $USER, timeout: ${TIMEOUT}s)..."

SECONDS_WAITED=0
while [ $SECONDS_WAITED -lt $TIMEOUT ]; do
  if pg_isready -h "$HOST" -p "$PORT" -U "$USER" >/dev/null 2>&1; then
    echo "✅ PostgreSQL is ready!"
    exit 0
  fi

  echo "⏳ Waiting... (${SECONDS_WAITED}s/${TIMEOUT}s)"
  sleep 2
  SECONDS_WAITED=$((SECONDS_WAITED + 2))
done

echo "❌ ERROR: PostgreSQL not ready after ${TIMEOUT} seconds"
exit 1
