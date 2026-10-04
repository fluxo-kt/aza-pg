#!/bin/bash
# aza-pg Custom Installation Marker
# Marks this data directory as created by an aza-pg image (ALTER SYSTEM writes it into
# postgresql.auto.conf inside PGDATA). `bun run cleanup` (scripts/docker/cleanup-artifacts.ts)
# reclaims only Docker volumes that carry this marker, so it never touches other Postgres data.

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

echo "[00-aza-pg-settings] Setting aza-pg custom installation marker..."

psql -U postgres -d "$TARGET_DB" -v ON_ERROR_STOP=1 <<'EOSQL'
-- Mark this as an aza-pg custom installation
-- Using single-quoted heredoc to prevent shell interpretation
ALTER SYSTEM SET "app.aza_pg_custom" = 'true';

-- Reload configuration to apply setting
SELECT pg_reload_conf();
EOSQL

echo "[00-aza-pg-settings] ✅ aza-pg custom marker set successfully"
