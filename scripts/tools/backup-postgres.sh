#!/bin/bash
# Backup PostgreSQL database using pg_dump
# Usage: ./backup-postgres.sh [database] [output-file]
# Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD
#
# Examples:
#   ./backup-postgres.sh                           # Backup 'postgres' db to auto-named file
#   ./backup-postgres.sh mydb                       # Backup 'mydb' to auto-named file
#   ./backup-postgres.sh mydb backup.sql.gz         # Backup 'mydb' to specific file
#   PGHOST=db.example.com PGUSER=admin ./backup-postgres.sh mydb

set -euo pipefail

# Guard: Check required commands
for cmd in pg_dump pg_isready gzip du; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ ERROR: Required command '$cmd' not found"
    echo "   Install PostgreSQL client tools: https://www.postgresql.org/download/"
    exit 1
  fi
done

# Configuration
DATABASE="${1:-postgres}"
OUTPUT_FILE="${2:-backup_${DATABASE}_$(date +%Y%m%d_%H%M%S).sql.gz}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"

# Guard: Check PGPASSWORD if connecting to non-local host
if [[ "$PGHOST" != "localhost" && "$PGHOST" != "127.0.0.1" ]] && [[ -z "${PGPASSWORD:-}" ]]; then
  echo "❌ ERROR: PGPASSWORD environment variable required for remote connections"
  echo "   Set password: export PGPASSWORD='your_password'"
  echo "   Or use .pgpass file: https://www.postgresql.org/docs/current/libpq-pgpass.html"
  exit 1
fi

# Guard: Check output directory is writable
OUTPUT_DIR=$(dirname "$OUTPUT_FILE")
if [[ ! -d "$OUTPUT_DIR" ]]; then
  echo "❌ ERROR: Output directory does not exist: $OUTPUT_DIR"
  echo "   Create directory: mkdir -p $OUTPUT_DIR"
  exit 1
fi
if [[ ! -w "$OUTPUT_DIR" ]]; then
  echo "❌ ERROR: Output directory not writable: $OUTPUT_DIR"
  echo "   Check permissions: ls -la $OUTPUT_DIR"
  exit 1
fi

# Guard: Prevent overwriting existing files
if [[ -f "$OUTPUT_FILE" ]]; then
  echo "❌ ERROR: Output file already exists: $OUTPUT_FILE"
  echo "   Remove existing file: rm $OUTPUT_FILE"
  echo "   Or specify different output file as second argument"
  exit 1
fi

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
  echo "   Troubleshooting:"
  echo "   - Verify host/port: pg_isready -h $PGHOST -p $PGPORT"
  echo "   - Check PostgreSQL is running: docker ps | grep postgres"
  echo "   - Check network/firewall rules"
  echo "   - Verify credentials (PGUSER, PGPASSWORD)"
  exit 1
fi
echo "✅ Connected"
echo

# Perform backup
echo "📦 Creating backup..."
if ! pg_dump \
  -h "$PGHOST" \
  -p "$PGPORT" \
  -U "$PGUSER" \
  -d "$DATABASE" \
  --format=plain \
  --no-owner \
  --no-acl \
  --verbose \
  2>&1 | gzip > "$OUTPUT_FILE"; then
  echo
  echo "❌ ERROR: Backup failed"
  echo "   Check pg_dump output above for details"
  echo "   Common issues:"
  echo "   - Database does not exist: psql -h $PGHOST -U $PGUSER -l"
  echo "   - Insufficient permissions for user $PGUSER"
  echo "   - Disk space: df -h $OUTPUT_DIR"
  rm -f "$OUTPUT_FILE"  # Clean up partial backup
  exit 1
fi

# Verify backup file was created and has content
if [[ ! -s "$OUTPUT_FILE" ]]; then
  echo "❌ ERROR: Backup file is empty or was not created"
  echo "   This usually indicates pg_dump failed silently"
  rm -f "$OUTPUT_FILE"
  exit 1
fi

# Verify backup is valid gzip
if ! gzip -t "$OUTPUT_FILE" 2>/dev/null; then
  echo "❌ ERROR: Backup file is corrupted (invalid gzip format)"
  echo "   The backup process may have been interrupted"
  rm -f "$OUTPUT_FILE"
  exit 1
fi

BACKUP_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo
echo "✅ Backup complete!"
echo "File: $OUTPUT_FILE"
echo "Size: $BACKUP_SIZE"
echo

# Show backup info
echo "Backup contains:"
zcat "$OUTPUT_FILE" | grep -E "^(CREATE TABLE|CREATE INDEX|CREATE EXTENSION)" | head -20 || echo "(no tables/indexes/extensions found)"
echo "..."
echo
echo "To restore: gunzip -c $OUTPUT_FILE | psql -h HOST -U USER -d DATABASE"
