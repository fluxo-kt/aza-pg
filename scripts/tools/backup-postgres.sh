#!/bin/bash
# Backup PostgreSQL database using pg_dump
# Usage: ./backup-postgres.sh [database] [output-file]
# Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD

set -e

DATABASE="${1:-postgres}"
OUTPUT_FILE="${2:-backup_${DATABASE}_$(date +%Y%m%d_%H%M%S).sql.gz}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"

echo "========================================"
echo "PostgreSQL Backup"
echo "========================================"
echo "Database: $DATABASE"
echo "Host: $PGHOST:$PGPORT"
echo "User: $PGUSER"
echo "Output: $OUTPUT_FILE"
echo

# Check PostgreSQL is accessible
echo "🔍 Checking PostgreSQL connection..."
if ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
  echo "❌ ERROR: PostgreSQL not accessible at $PGHOST:$PGPORT"
  exit 1
fi
echo "✅ Connected"
echo

# Perform backup
echo "📦 Creating backup..."
pg_dump \
  -h "$PGHOST" \
  -p "$PGPORT" \
  -U "$PGUSER" \
  -d "$DATABASE" \
  --format=plain \
  --no-owner \
  --no-acl \
  --verbose \
  2>&1 | gzip > "$OUTPUT_FILE"

# Verify backup
BACKUP_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo
echo "✅ Backup complete!"
echo "File: $OUTPUT_FILE"
echo "Size: $BACKUP_SIZE"
echo

# Show backup info
echo "Backup contains:"
zcat "$OUTPUT_FILE" | grep -E "^(CREATE TABLE|CREATE INDEX|CREATE EXTENSION)" | head -20
echo "..."
echo
echo "To restore: gunzip -c $OUTPUT_FILE | psql -h HOST -U USER -d DATABASE"
