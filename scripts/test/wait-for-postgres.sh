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

# Source common library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Guard: Check required commands
if ! check_command pg_isready; then
  echo "   Install PostgreSQL client tools: https://www.postgresql.org/download/"
  exit 1
fi

HOST="${1:-${PGHOST:-localhost}}"
PORT="${2:-${PGPORT:-5432}}"
USER="${3:-${PGUSER:-postgres}}"
TIMEOUT="${4:-60}"

# Use common library function
if ! wait_for_postgres "$HOST" "$PORT" "$USER" "$TIMEOUT"; then
  echo
  echo "Troubleshooting:"
  echo "  - Check PostgreSQL is running: docker ps | grep postgres"
  echo "  - Verify host/port: pg_isready -h $HOST -p $PORT"
  echo "  - Check container logs: docker logs <postgres-container>"
  echo "  - Check network connectivity: nc -zv $HOST $PORT"
  echo "  - Verify PostgreSQL is accepting connections (not in recovery mode)"
  exit 1
fi
