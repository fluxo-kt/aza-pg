#!/bin/bash
# Restore PostgreSQL database from backup
# Usage: ./restore-postgres.sh <backup-file> [database]
# Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <backup-file> [database]"
  echo "Example: $0 backup_20250131_120000.sql.gz postgres"
  exit 1
fi

BACKUP_FILE="$1"
DATABASE="${2:-postgres}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"

echo "========================================"
echo "PostgreSQL Restore"
echo "========================================"
echo "Backup file: $BACKUP_FILE"
echo "Database: $DATABASE"
echo "Host: $PGHOST:$PGPORT"
echo "User: $PGUSER"
echo

# Verify backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Check PostgreSQL is accessible
echo "🔍 Checking PostgreSQL connection..."
if ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
  echo "❌ ERROR: PostgreSQL not accessible at $PGHOST:$PGPORT"
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
  gunzip -c "$BACKUP_FILE" | psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DATABASE" --quiet
else
  echo "Restoring uncompressed backup..."
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DATABASE" -f "$BACKUP_FILE" --quiet
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
  LIMIT 10;" 2>/dev/null || true
