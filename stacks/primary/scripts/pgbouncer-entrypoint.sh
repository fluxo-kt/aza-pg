#!/bin/sh
# Safe PgBouncer bootstrap that injects password without leaking into config
set -eu

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

cp "$TEMPLATE" "$OUTPUT"
chmod 600 "$OUTPUT"

echo "[pgbouncer-entrypoint] Configuration rendered to $OUTPUT"
exec pgbouncer "$OUTPUT"
