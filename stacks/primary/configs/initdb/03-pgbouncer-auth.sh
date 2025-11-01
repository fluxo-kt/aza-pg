#!/bin/bash
# PgBouncer authentication setup
# Creates pgbouncer_auth user and lookup function for SCRAM-SHA-256

set -e

if [ -z "$PGBOUNCER_AUTH_PASS" ]; then
  echo "ERROR: PGBOUNCER_AUTH_PASS environment variable is not set"
  echo "Set it in .env file or via: -e PGBOUNCER_AUTH_PASS=yourpass"
  exit 1
fi

echo "[pgbouncer-auth] Creating PgBouncer auth user and lookup function..."

psql -v ON_ERROR_STOP=1 -v pgbouncer_password="$PGBOUNCER_AUTH_PASS" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
        CREATE ROLE pgbouncer_auth LOGIN PASSWORD :'pgbouncer_password' NOINHERIT;
        RAISE NOTICE 'PgBouncer auth user created';
      ELSE
        ALTER ROLE pgbouncer_auth WITH PASSWORD :'pgbouncer_password';
        RAISE NOTICE 'PgBouncer auth user password updated';
      END IF;
    END$$;

    CREATE OR REPLACE FUNCTION pgbouncer_lookup(user_name TEXT)
    RETURNS TABLE(username TEXT, password TEXT)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog AS $$
      SELECT usename::text, passwd::text FROM pg_shadow WHERE usename = user_name;
    $$;

    REVOKE ALL ON FUNCTION pgbouncer_lookup(TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION pgbouncer_lookup(TEXT) TO pgbouncer_auth;
EOSQL

echo "[pgbouncer-auth] PgBouncer auth setup completed successfully"
