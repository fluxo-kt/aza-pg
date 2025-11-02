#!/bin/bash
# Wait for PostgreSQL to be ready
# Usage: ./wait-for-postgres.sh [host] [port] [user] [timeout]
# Environment variables: PGHOST, PGPORT, PGUSER (defaults if not provided)
#
# Examples:
#   ./wait-for-postgres.sh                              # localhost:5432, postgres user, 60s timeout
#   ./wait-for-postgres.sh db.example.com 5432 admin    # Remote host with custom user
#   PGHOST=localhost PGPORT=6432 ./wait-for-postgres.sh # Via PgBouncer
#   ./wait-for-postgres.sh localhost 5432 postgres 120  # 2 minute timeout

set -euo pipefail

# Guard: Check required commands
if ! command -v pg_isready &>/dev/null; then
  echo "❌ ERROR: Required command 'pg_isready' not found"
  echo "   Install PostgreSQL client tools: https://www.postgresql.org/download/"
  exit 1
fi

HOST="${1:-${PGHOST:-localhost}}"
PORT="${2:-${PGPORT:-5432}}"
USER="${3:-${PGUSER:-postgres}}"
TIMEOUT="${4:-60}"

# Guard: Validate timeout is a number
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "❌ ERROR: Invalid timeout value: $TIMEOUT"
  echo "   Timeout must be a positive integer (seconds)"
  echo "   Example: $0 localhost 5432 postgres 120"
  exit 1
fi

# Guard: Validate port is a number
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "❌ ERROR: Invalid port value: $PORT"
  echo "   Port must be a number between 1-65535"
  echo "   Example: $0 localhost 5432 postgres 60"
  exit 1
fi

# Guard: Validate port range
if [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "❌ ERROR: Port out of range: $PORT"
  echo "   Port must be between 1-65535"
  exit 1
fi

echo "Waiting for PostgreSQL at $HOST:$PORT (user: $USER, timeout: ${TIMEOUT}s)..."

SECONDS_WAITED=0
while [[ $SECONDS_WAITED -lt $TIMEOUT ]]; do
  if pg_isready -h "$HOST" -p "$PORT" -U "$USER" >/dev/null 2>&1; then
    echo "✅ PostgreSQL is ready!"
    exit 0
  fi

  echo "⏳ Waiting... (${SECONDS_WAITED}s/${TIMEOUT}s)"
  sleep 2
  SECONDS_WAITED=$((SECONDS_WAITED + 2))
done

echo "❌ ERROR: PostgreSQL not ready after ${TIMEOUT} seconds"
echo
echo "Troubleshooting:"
echo "  - Check PostgreSQL is running: docker ps | grep postgres"
echo "  - Verify host/port: pg_isready -h $HOST -p $PORT"
echo "  - Check container logs: docker logs <postgres-container>"
echo "  - Check network connectivity: nc -zv $HOST $PORT"
echo "  - Verify PostgreSQL is accepting connections (not in recovery mode)"
exit 1
