#!/bin/bash
# Safe PgBouncer bootstrap that injects password without leaking into config
set -euo pipefail

TEMPLATE="/etc/pgbouncer/pgbouncer.ini.template"
OUTPUT="/tmp/pgbouncer.ini"
PGPASSFILE_PATH="/tmp/.pgpass"

if [ -z "${PGBOUNCER_AUTH_PASS:-}" ]; then
  echo "[PGBOUNCER] ERROR: PGBOUNCER_AUTH_PASS not set" >&2
  exit 1
fi

# Escape characters that need quoting inside .pgpass (colon and backslash)
escape_password() {
  # shellcheck disable=SC2016
  local result
  result=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g')
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "[PGBOUNCER] ERROR: Password escaping failed (sed exit code: $exit_code)" >&2
    return 1
  fi
  printf '%s' "$result"
}

escaped_pass="$(escape_password "$PGBOUNCER_AUTH_PASS")" || exit 1

umask 077
# Write .pgpass entries for both PostgreSQL and PgBouncer connections
# Format: hostname:port:database:username:password
printf 'postgres:5432:postgres:pgbouncer_auth:%s\n' "$escaped_pass" > "$PGPASSFILE_PATH"
printf 'localhost:6432:postgres:pgbouncer_auth:%s\n' "$escaped_pass" >> "$PGPASSFILE_PATH"
printf 'pgbouncer:6432:postgres:pgbouncer_auth:%s\n' "$escaped_pass" >> "$PGPASSFILE_PATH"

# Verify .pgpass has secure permissions (must be 600 or PostgreSQL will reject it)
if ! chmod 600 "$PGPASSFILE_PATH" 2>/dev/null; then
    echo "[PGBOUNCER] ERROR: Failed to set .pgpass permissions" >&2
    exit 1
fi
# Double-check permissions are actually 600
actual_perms=$(stat -c "%a" "$PGPASSFILE_PATH" 2>/dev/null || stat -f "%OLp" "$PGPASSFILE_PATH" 2>/dev/null || echo "unknown")
if [[ "$actual_perms" != "600" ]]; then
    echo "[PGBOUNCER] ERROR: .pgpass permissions are $actual_perms (expected 600)" >&2
    exit 1
fi
export PGPASSFILE="$PGPASSFILE_PATH"

# Set environment variables with secure defaults
PGBOUNCER_LISTEN_ADDR="${PGBOUNCER_LISTEN_ADDR:-127.0.0.1}"
PGBOUNCER_SERVER_SSLMODE="${PGBOUNCER_SERVER_SSLMODE:-prefer}"
PGBOUNCER_MAX_CLIENT_CONN="${PGBOUNCER_MAX_CLIENT_CONN:-200}"
PGBOUNCER_DEFAULT_POOL_SIZE="${PGBOUNCER_DEFAULT_POOL_SIZE:-25}"

# Validate listen address format (IP address or wildcard patterns)
# Accepts: IPv4 (e.g., 192.168.1.1), 0.0.0.0, *, *.*.*.*
if ! [[ "$PGBOUNCER_LISTEN_ADDR" =~ ^(\*|([0-9]{1,3}\.){3}[0-9]{1,3}|(\*\.){0,3}\*)$ ]]; then
    echo "[PGBOUNCER] ERROR: Invalid PGBOUNCER_LISTEN_ADDR format: '$PGBOUNCER_LISTEN_ADDR'" >&2
    echo "[PGBOUNCER] Expected: IPv4 address (e.g., 127.0.0.1), 0.0.0.0, or * wildcard" >&2
    exit 1
fi

# Additional validation: Check octet ranges for IP addresses (0-255)
if [[ "$PGBOUNCER_LISTEN_ADDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    IFS='.' read -r -a octets <<< "$PGBOUNCER_LISTEN_ADDR"
    for octet in "${octets[@]}"; do
        if [[ $octet -gt 255 ]]; then
            echo "[PGBOUNCER] ERROR: Invalid IP address: octet '$octet' exceeds 255" >&2
            exit 1
        fi
    done
fi

# Validate sslmode value
if ! [[ "$PGBOUNCER_SERVER_SSLMODE" =~ ^(disable|allow|prefer|require|verify-ca|verify-full)$ ]]; then
    echo "[PGBOUNCER] ERROR: Invalid PGBOUNCER_SERVER_SSLMODE: '$PGBOUNCER_SERVER_SSLMODE'" >&2
    echo "[PGBOUNCER] Expected: disable, allow, prefer, require, verify-ca, or verify-full" >&2
    exit 1
fi

# Render configuration with all placeholders replaced
sed -e "s|PGBOUNCER_LISTEN_ADDR_PLACEHOLDER|${PGBOUNCER_LISTEN_ADDR}|g" \
    -e "s|PGBOUNCER_SERVER_SSLMODE_PLACEHOLDER|${PGBOUNCER_SERVER_SSLMODE}|g" \
    -e "s|PGBOUNCER_MAX_CLIENT_CONN_PLACEHOLDER|${PGBOUNCER_MAX_CLIENT_CONN}|g" \
    -e "s|PGBOUNCER_DEFAULT_POOL_SIZE_PLACEHOLDER|${PGBOUNCER_DEFAULT_POOL_SIZE}|g" \
    "$TEMPLATE" > "$OUTPUT"
chmod 600 "$OUTPUT"

echo "[PGBOUNCER] Configuration rendered to $OUTPUT"
exec pgbouncer "$OUTPUT"
