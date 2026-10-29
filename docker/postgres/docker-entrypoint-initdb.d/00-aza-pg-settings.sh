#!/bin/bash
# aza-pg Custom Installation Marker
# Marks this data directory as created by an aza-pg image (ALTER SYSTEM writes it into
# postgresql.auto.conf inside PGDATA). `bun run cleanup` (scripts/docker/cleanup-artifacts.ts)
# reclaims only Docker volumes that carry this marker, so it never touches other Postgres data.

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

echo "[00-aza-pg-settings] Setting aza-pg custom installation marker..."

psql --username "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 <<'EOSQL'
-- Mark this as an aza-pg custom installation
-- Using single-quoted heredoc to prevent shell interpretation
-- ALTER SYSTEM writes postgresql.auto.conf, which is all `bun run cleanup` reads (it finds aza-pg volumes by this
-- line) and which the final server loads at start. No reload: on this temporary init server (listen_addresses='')
-- one would log "listen_addresses cannot be changed" and "configuration file … contains errors" on every new cluster.
ALTER SYSTEM SET "app.aza_pg_custom" = 'true';
EOSQL

echo "[00-aza-pg-settings] ✅ aza-pg custom marker set successfully"
