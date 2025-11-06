#!/bin/bash
#
# pgsodium Server Secret Initialization
# ==========================================
# Initializes pgsodium server secret key required for supabase_vault encryption.
# This script creates the master encryption key used by pgsodium for envelope encryption.
#
# Prerequisites:
# - pgsodium extension must be created (done in 01-extensions.sql)
# - Runs after extension creation, before application-specific schemas
#
# Security Note:
# - Server secret is stored in pgsodium.key table
# - Required for supabase_vault secret encryption/decryption
# - Without this, supabase_vault operations will fail with "no server secret key defined"

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        -- Create pgsodium extension if it doesn't exist
        CREATE EXTENSION IF NOT EXISTS pgsodium;

        -- Disable pgsodium event triggers to avoid conflicts with other extensions
        -- (pgsodium tries to check non-existent pgsodium.enable_event_trigger GUC)
        ALTER EVENT TRIGGER pgsodium_trg_mask_update DISABLE;

        -- Create server secret key if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM pgsodium.key WHERE name = 'pgsodium_root') THEN
            PERFORM pgsodium.create_key(name := 'pgsodium_root');
            RAISE NOTICE 'pgsodium server secret initialized';
        ELSE
            RAISE NOTICE 'pgsodium server secret already exists';
        END IF;
    END
    \$\$;
EOSQL

echo "pgsodium initialization complete"
