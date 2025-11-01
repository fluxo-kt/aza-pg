#!/bin/bash
# Wrapper script for pgbouncer_auth.sql with environment variable substitution

set -e

if [ -z "$PGBOUNCER_AUTH_PASS" ]; then
  echo "ERROR: PGBOUNCER_AUTH_PASS environment variable is not set"
  exit 1
fi

envsubst < /docker-entrypoint-initdb.d/pgbouncer_auth.sql.template | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"

echo "PgBouncer auth setup completed successfully"
