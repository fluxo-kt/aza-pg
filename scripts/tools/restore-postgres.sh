#!/bin/bash
# Restore PostgreSQL database from backup
# Usage: ./restore-postgres.sh <backup-file> [database]
# Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD
#
# Examples:
#   ./restore-postgres.sh backup.sql.gz                    # Restore to 'postgres' database
#   ./restore-postgres.sh backup.sql.gz mydb                # Restore to 'mydb' database
#   PGHOST=db.example.com ./restore-postgres.sh backup.sql.gz

set -euo pipefail

# Guard: Check required commands
for cmd in psql pg_isready gunzip; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ ERROR: Required command '$cmd' not found"
    echo "   Install PostgreSQL client tools: https://www.postgresql.org/download/"
    exit 1
  fi
done

# Guard: Check backup file argument
if [[ -z "${1:-}" ]]; then
  echo "❌ ERROR: Backup file argument required"
  echo
  echo "Usage: $0 <backup-file> [database]"
  echo
  echo "Examples:"
  echo "  $0 backup_20250131_120000.sql.gz                # Restore to 'postgres' db"
  echo "  $0 backup_20250131_120000.sql.gz mydb            # Restore to 'mydb' db"
  echo "  PGHOST=remote.host $0 backup.sql.gz              # Restore to remote host"
  exit 1
fi

BACKUP_FILE="$1"
DATABASE="${2:-postgres}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"

# Guard: Verify backup file exists
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "❌ ERROR: Backup file not found: $BACKUP_FILE"
  echo "   Check file path: ls -la $(dirname "$BACKUP_FILE")"
  exit 1
fi

# Guard: Verify backup file is readable
if [[ ! -r "$BACKUP_FILE" ]]; then
  echo "❌ ERROR: Backup file not readable: $BACKUP_FILE"
  echo "   Check permissions: ls -la $BACKUP_FILE"
  exit 1
fi

# Guard: Verify backup file format
if [[ "$BACKUP_FILE" == *.gz ]]; then
  if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
    echo "❌ ERROR: Backup file is corrupted (invalid gzip format)"
    echo "   File: $BACKUP_FILE"
    echo "   Try: gunzip -t $BACKUP_FILE"
    exit 1
  fi
fi

# Guard: Check PGPASSWORD if connecting to non-local host
if [[ "$PGHOST" != "localhost" && "$PGHOST" != "127.0.0.1" ]] && [[ -z "${PGPASSWORD:-}" ]]; then
  echo "❌ ERROR: PGPASSWORD environment variable required for remote connections"
  echo "   Set password: export PGPASSWORD='your_password'"
  echo "   Or use .pgpass file: https://www.postgresql.org/docs/current/libpq-pgpass.html"
  exit 1
fi

echo "========================================"
echo "PostgreSQL Restore"
echo "========================================"
echo "Backup file: $BACKUP_FILE"
echo "Database: $DATABASE"
echo "Host: $PGHOST:$PGPORT"
echo "User: $PGUSER"
echo

# Check PostgreSQL is accessible
echo "🔍 Checking PostgreSQL connection..."
if ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
  echo "❌ ERROR: PostgreSQL not accessible at $PGHOST:$PGPORT"
  echo "   Troubleshooting:"
  echo "   - Verify host/port: pg_isready -h $PGHOST -p $PGPORT"
  echo "   - Check PostgreSQL is running: docker ps | grep postgres"
  echo "   - Check network/firewall rules"
  echo "   - Verify credentials (PGUSER, PGPASSWORD)"
  exit 1
fi
echo "✅ Connected"
echo

# Warn about destructive operation
echo "⚠️  WARNING: This will overwrite the database '$DATABASE'"
echo "Press Ctrl+C to cancel, or Enter to continue..."
read -r

# Perform restore
echo "📥 Restoring backup..."
if [[ "$BACKUP_FILE" == *.gz ]]; then
  echo "Decompressing and restoring..."
  if ! gunzip -c "$BACKUP_FILE" | psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DATABASE" --quiet 2>&1; then
    echo
    echo "❌ ERROR: Restore failed"
    echo "   Check psql output above for details"
    echo "   Common issues:"
    echo "   - Database '$DATABASE' does not exist: createdb -h $PGHOST -U $PGUSER $DATABASE"
    echo "   - Insufficient permissions for user $PGUSER"
    echo "   - Conflicting extensions: DROP EXTENSION ... CASCADE"
    echo "   - Check PostgreSQL logs: docker logs <postgres-container>"
    exit 1
  fi
else
  echo "Restoring uncompressed backup..."
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DATABASE" -f "$BACKUP_FILE" --quiet 2>&1; then
    echo
    echo "❌ ERROR: Restore failed"
    echo "   Check psql output above for details"
    exit 1
  fi
fi

echo
echo "✅ Restore complete!"
echo "Database: $DATABASE"
echo

# Verify restore
echo "Database stats:"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DATABASE" -c "\
  SELECT schemaname, tablename, \
         pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size \
  FROM pg_tables \
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema') \
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC \
  LIMIT 10;" 2>/dev/null || echo "(Could not retrieve table statistics)"
