#!/bin/bash
# aza-pg Custom Installation Marker
# Set marker setting to identify this as a custom aza-pg installation (not Supabase)
#
# This setting is used by patched pgflow functions (e.g., is_local()) to detect
# that they're running in a custom Postgres build rather than Supabase environment.

set -euo pipefail

TARGET_DB="${POSTGRES_DB:-postgres}"

echo "[00-aza-pg-settings] Setting aza-pg custom installation marker..."

psql -U postgres -d "$TARGET_DB" <<EOSQL
-- Mark this as an aza-pg custom installation
ALTER SYSTEM SET app.settings.aza_pg_custom = 'true';

-- Reload configuration to apply setting
SELECT pg_reload_conf();
EOSQL

echo "[00-aza-pg-settings] ✅ aza-pg custom marker set successfully"
