#!/bin/bash
# PgBouncer authentication setup
# Creates pgbouncer_auth user and lookup function for SCRAM-SHA-256

set -euo pipefail

if [ -z "$PGBOUNCER_AUTH_PASS" ]; then
  echo "ERROR: PGBOUNCER_AUTH_PASS environment variable is not set"
  echo "Set it in .env file or via: -e PGBOUNCER_AUTH_PASS=yourpass"
  exit 1
fi

echo "[pgbouncer-auth] Creating PgBouncer auth user and lookup function..."

psql -v ON_ERROR_STOP=1 -v pgbouncer_password="$PGBOUNCER_AUTH_PASS" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE OR REPLACE FUNCTION pg_temp.setup_pgbouncer_auth(p_password TEXT)
    RETURNS void AS \$func\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
        EXECUTE format('CREATE ROLE pgbouncer_auth LOGIN PASSWORD %L NOINHERIT', p_password);
        RAISE NOTICE 'PgBouncer auth user created';
      ELSE
        EXECUTE format('ALTER ROLE pgbouncer_auth WITH PASSWORD %L', p_password);
        RAISE NOTICE 'PgBouncer auth user password updated';
      END IF;
    END
    \$func\$ LANGUAGE plpgsql;

    SELECT pg_temp.setup_pgbouncer_auth(:'pgbouncer_password');

    ALTER ROLE pgbouncer_auth CONNECTION LIMIT 10;

    CREATE OR REPLACE FUNCTION pgbouncer_lookup(user_name TEXT)
    RETURNS TABLE(username TEXT, password TEXT)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog AS \$FUNC\$
      SELECT usename::text, passwd::text FROM pg_shadow WHERE usename = user_name;
    \$FUNC\$;

    REVOKE ALL ON FUNCTION pgbouncer_lookup(TEXT) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION pgbouncer_lookup(TEXT) TO pgbouncer_auth;
EOSQL

echo "[pgbouncer-auth] PgBouncer auth setup completed successfully"
