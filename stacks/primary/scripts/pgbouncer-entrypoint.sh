#!/bin/sh
# Safe PgBouncer bootstrap that injects password without leaking into config
set -eu

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
  result=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g')
  exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo "[PGBOUNCER] ERROR: Password escaping failed (sed exit code: $exit_code)" >&2
    return 1
  fi
  printf '%s' "$result"
}

escaped_pass="$(escape_password "$PGBOUNCER_AUTH_PASS")" || exit 1

umask 077
# Write .pgpass entries for PostgreSQL and PgBouncer connections (used for health checks only)
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
if [ "$actual_perms" != "600" ]; then
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
case "$PGBOUNCER_LISTEN_ADDR" in
  '*' | '0.0.0.0' | '127.0.0.1' | '*.0.0.0' | '*.*.0.0' | '*.*.*.0' | '*.*.*.*.0')
    ;;
  [0-9]*)
    # Match IPv4 address pattern: digits.digits.digits.digits
    case "$PGBOUNCER_LISTEN_ADDR" in
      [0-9]*.[0-9]*.[0-9]*.[0-9]*)
        ;;
      *)
        echo "[PGBOUNCER] ERROR: Invalid PGBOUNCER_LISTEN_ADDR format: '$PGBOUNCER_LISTEN_ADDR'" >&2
        echo "[PGBOUNCER] Expected: IPv4 address (e.g., 127.0.0.1), 0.0.0.0, or * wildcard" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "[PGBOUNCER] ERROR: Invalid PGBOUNCER_LISTEN_ADDR format: '$PGBOUNCER_LISTEN_ADDR'" >&2
    echo "[PGBOUNCER] Expected: IPv4 address (e.g., 127.0.0.1), 0.0.0.0, or * wildcard" >&2
    exit 1
    ;;
esac

# Additional validation: Check octet ranges for IP addresses (0-255)
case "$PGBOUNCER_LISTEN_ADDR" in
  [0-9]*.[0-9]*.[0-9]*.[0-9]*)
    # Split IP by dots and validate each octet
    octet1=$(printf '%s' "$PGBOUNCER_LISTEN_ADDR" | cut -d. -f1)
    octet2=$(printf '%s' "$PGBOUNCER_LISTEN_ADDR" | cut -d. -f2)
    octet3=$(printf '%s' "$PGBOUNCER_LISTEN_ADDR" | cut -d. -f3)
    octet4=$(printf '%s' "$PGBOUNCER_LISTEN_ADDR" | cut -d. -f4)

    # Validate each octet is numeric and <= 255
    validate_octet() {
      octet_val="$1"
      octet_name="$2"
      # Check if numeric and not empty
      case "$octet_val" in
        [0-9] | [0-9][0-9] | [1][0-9][0-9] | [2][0-4][0-9] | [2][5][0-5])
          ;;
        *)
          echo "[PGBOUNCER] ERROR: Invalid IP address: $octet_name octet '$octet_val' is invalid (must be 0-255)" >&2
          exit 1
          ;;
      esac
    }

    validate_octet "$octet1" "first"
    validate_octet "$octet2" "second"
    validate_octet "$octet3" "third"
    validate_octet "$octet4" "fourth"
    ;;
esac

# Validate sslmode value
case "$PGBOUNCER_SERVER_SSLMODE" in
  disable | allow | prefer | require | verify-ca | verify-full)
    ;;
  *)
    echo "[PGBOUNCER] ERROR: Invalid PGBOUNCER_SERVER_SSLMODE: '$PGBOUNCER_SERVER_SSLMODE'" >&2
    echo "[PGBOUNCER] Expected: disable, allow, prefer, require, verify-ca, or verify-full" >&2
    exit 1
    ;;
esac

# Generate userlist.txt with auth_user credentials
# PgBouncer needs plaintext password for auth_user to connect to PostgreSQL for auth_query
# Note: userlist.txt is secured with 600 permissions and only lives in container memory
USERLIST_PATH="/tmp/userlist.txt"

# For auth_user connecting to PostgreSQL, PgBouncer needs plaintext password
# (SCRAM hash only works for client->PgBouncer, not PgBouncer->PostgreSQL)
printf '"pgbouncer_auth" "%s"\n' "$PGBOUNCER_AUTH_PASS" > "$USERLIST_PATH"
chmod 600 "$USERLIST_PATH"
echo "[PGBOUNCER] Generated userlist.txt at $USERLIST_PATH"

# Render configuration with all placeholders replaced
sed -e "s|PGBOUNCER_LISTEN_ADDR_PLACEHOLDER|${PGBOUNCER_LISTEN_ADDR}|g" \
    -e "s|PGBOUNCER_SERVER_SSLMODE_PLACEHOLDER|${PGBOUNCER_SERVER_SSLMODE}|g" \
    -e "s|PGBOUNCER_MAX_CLIENT_CONN_PLACEHOLDER|${PGBOUNCER_MAX_CLIENT_CONN}|g" \
    -e "s|PGBOUNCER_DEFAULT_POOL_SIZE_PLACEHOLDER|${PGBOUNCER_DEFAULT_POOL_SIZE}|g" \
    "$TEMPLATE" > "$OUTPUT"
chmod 600 "$OUTPUT"

echo "[PGBOUNCER] Configuration rendered to $OUTPUT"
exec pgbouncer "$OUTPUT"
