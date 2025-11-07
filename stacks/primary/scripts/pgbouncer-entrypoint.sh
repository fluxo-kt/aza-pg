#!/bin/bash
# Safe PgBouncer bootstrap that injects password without leaking into config
set -euo pipefail

TEMPLATE="/etc/pgbouncer/pgbouncer.ini.template"
OUTPUT="/tmp/pgbouncer.ini"
PGPASSFILE_PATH="/tmp/.pgpass"

if [ -z "${PGBOUNCER_AUTH_PASS:-}" ]; then
  echo "[pgbouncer-entrypoint] ERROR: PGBOUNCER_AUTH_PASS not set" >&2
  exit 1
fi

# Escape characters that need quoting inside .pgpass (colon and backslash)
escape_password() {
  # shellcheck disable=SC2016
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g'
}

escaped_pass="$(escape_password "$PGBOUNCER_AUTH_PASS")"

umask 077
printf 'postgres:5432:postgres:pgbouncer_auth:%s\n' "$escaped_pass" > "$PGPASSFILE_PATH"
export PGPASSFILE="$PGPASSFILE_PATH"

# Substitute listen_addr with environment variable (default: 127.0.0.1 for security)
PGBOUNCER_LISTEN_ADDR="${PGBOUNCER_LISTEN_ADDR:-127.0.0.1}"
sed "s/PGBOUNCER_LISTEN_ADDR_PLACEHOLDER/${PGBOUNCER_LISTEN_ADDR}/g" "$TEMPLATE" > "$OUTPUT"
chmod 600 "$OUTPUT"

echo "[pgbouncer-entrypoint] Configuration rendered to $OUTPUT"
exec pgbouncer "$OUTPUT"
