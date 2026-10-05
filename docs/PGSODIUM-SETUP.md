# pgsodium & Vault Setup Guide

pgsodium and supabase_vault are preloaded by default and work without configuration. This guide covers where their root key lives, how to supply your own, and how to move a database off the key older images published.

## The Root Key

pgsodium derives every key it uses (Vault secrets, `derive_key`, Transparent Column Encryption) from one 32-byte root key. The server reads it at every start; it never appears in SQL.

| Situation                          | Root key                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| New data directory (default)       | Random, created at the first start in `$PGDATA/pgsodium_root.key` (mode 600, owner postgres) |
| `PGSODIUM_KEY_FILE` is set         | That file: 64 hex characters, readable by postgres; nothing is created in the data directory |
| Your own `pgsodium_getkey` mounted | Whatever it prints; the image creates, checks and warns about nothing                        |
| Data directory from an older image | The key older images published, written to `$PGDATA/pgsodium_root.key`; every start warns    |

A new data directory records which of the first three it was created with (`$PGDATA/pgsodium_key_source`). If that source is gone at a later start — the key file deleted, `PGSODIUM_KEY_FILE` unset, your getkey no longer mounted — the container stops and names it, instead of starting with another key under which existing encrypted data is unreadable.

**What carries the key:** file-level copies of the data directory do — volume backups, `pg_basebackup` (so replicas decrypt what the primary encrypted) and pgBackRest backups. `pg_dump` output does not: restoring a dump into a new container gives it a new key, and values encrypted under the old one cannot be decrypted. Keep a copy of the key file, or supply your own with `PGSODIUM_KEY_FILE`.

**A wrong `PGSODIUM_KEY_FILE`** (unreadable, or not 64 hex characters) stops the container with `ERROR: PGSODIUM_KEY_FILE=<path> must be readable by postgres and hold 64 hex characters`.

## Supplying Your Own Key

```bash
head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n' > pgsodium.key   # or: openssl rand -hex 32
chmod 644 pgsodium.key   # postgres in the container must read it

docker run -d \
  -e POSTGRES_PASSWORD=secure_password \
  -e PGSODIUM_KEY_FILE=/run/secrets/pgsodium.key \
  -v "$PWD/pgsodium.key:/run/secrets/pgsodium.key:ro" \
  ghcr.io/fluxo-kt/aza-pg:18
```

Switching an existing database to a different key makes data encrypted under the old one unreadable; follow the rotation steps below instead.

To fetch the key from a secret manager instead of a file, mount your own executable at `/usr/share/postgresql/18/extension/pgsodium_getkey`; it must print the 64 hex characters on stdout and exit 0. Examples: [pgsodium getkey scripts](https://github.com/michelp/pgsodium/tree/main/getkey_scripts). A failing script stops the server.

## Rotating the Published Key

A data directory created by an image that shipped a fixed key keeps using that key, because anything it encrypted needs it. The key is public, so anyone with a copy of your data can decrypt those values. The container log says so at every start:

```
[POSTGRES] [AUTO-CONFIG] WARNING: pgsodium uses the key older aza-pg images published (...pgsodium_root.key); ...
```

1. **List what is encrypted.** Vault secrets: `SELECT name FROM vault.secrets;`. Your own pgsodium use: columns with `SECURITY LABEL FOR pgsodium`, and values you encrypted with `derive_key` or server-key functions.
2. **If nothing is encrypted:** write a new key and restart:
   `docker exec -u postgres <container> sh -c 'head -c 32 /dev/urandom | od -An -v -tx1 | tr -d " \n" > "$PGDATA/pgsodium_root.key"'`
3. **Otherwise,** while the old key is still active, read the plaintext out (for Vault: `SELECT name, description, decrypted_secret FROM vault.decrypted_secrets;`), write the new key as in step 2, restart, and store the values again (`vault.update_secret` or `vault.create_secret`; re-insert TCE columns). Do this in a maintenance window: the plaintext exists outside the database until you finish.

## Coolify Deployment

PostgreSQL 18 needs the volume at `/var/lib/postgresql` (not `/var/lib/postgresql/data`; [Coolify issue](https://github.com/coollabsio/coolify/issues/7279)). pgsodium and Vault need nothing else; to supply your own key with Docker Compose:

```yaml
services:
  postgres:
    image: ghcr.io/fluxo-kt/aza-pg:18
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_MEMORY: ${POSTGRES_MEMORY:-2048}
      PGSODIUM_KEY_FILE: /run/secrets/pgsodium.key
    volumes:
      - type: volume
        source: postgres_data
        target: /var/lib/postgresql
      - type: bind
        source: ./pgsodium.key
        target: /run/secrets/pgsodium.key
        read_only: true
        content: |
          YOUR_64_HEX_CHAR_KEY_HERE

volumes:
  postgres_data:
```

With Coolify's **Databases → PostgreSQL** form, set the Persistent Storage destination to `/var/lib/postgresql`, create the key file on the host, add it as a bind mount, and set `PGSODIUM_KEY_FILE` to its destination path.

## Why Both Extensions Are Preloaded

Both pgsodium and supabase_vault load the root key in their `_PG_init()`, which runs only for preloaded libraries; without the preload, `vault.create_secret()` fails with `no server secret key defined`. `POSTGRES_SHARED_PRELOAD_LIBRARIES` replaces the default list, so an override must keep both (and the order: pgsodium before supabase_vault).

## Optional: pgsodium Key Table Row

`ENABLE_PGSODIUM_INIT=true` makes first start also create the `pgsodium_root` row in `pgsodium.key` (`docker-entrypoint-initdb.d/03-pgsodium-init.sh`). Vault does not need it.

---

## Verification

### Check Server Key Loaded

```sql
-- Both should show in PostgreSQL logs at startup:
-- LOG: pgsodium primary server secret key loaded
-- LOG: vault primary server secret key loaded
```

### Test pgsodium

```sql
-- Key derivation (requires preloading)
SELECT pgsodium.derive_key(1, 32, 'pgsodium'::bytea);

-- Direct encryption (works without preload)
SELECT pgsodium.crypto_aead_det_encrypt(
  'message'::bytea,
  'additional'::bytea,
  pgsodium.crypto_aead_det_keygen()
);
```

### Test Vault

```sql
-- Create encrypted secret
SELECT vault.create_secret('my_api_key_value', 'api_key', 'Production API key');

-- Retrieve decrypted secret
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'api_key';

-- Verify encryption at rest (should NOT show plaintext)
SELECT secret FROM vault.secrets WHERE name = 'api_key';
```

---

## Basic Usage Examples

Common pgsodium cryptographic operations with SQL examples.

### Secretbox Encryption (Symmetric, Authenticated)

Secretbox provides authenticated encryption using XSalsa20 stream cipher and Poly1305 MAC.

```sql
-- Generate key and nonce
SELECT pgsodium.crypto_secretbox_keygen() AS key;    -- 32 bytes
SELECT pgsodium.crypto_secretbox_noncegen() AS nonce; -- 24 bytes

-- Encrypt/decrypt round-trip
WITH keys AS (
  SELECT
    pgsodium.crypto_secretbox_keygen() AS key,
    pgsodium.crypto_secretbox_noncegen() AS nonce
)
SELECT convert_from(
  pgsodium.crypto_secretbox_open(
    pgsodium.crypto_secretbox('secret data'::bytea, nonce, key),
    nonce, key
  ), 'utf8'
) AS decrypted FROM keys;
```

### Hashing (Deterministic)

Generic hashing using BLAKE2b algorithm.

```sql
-- Generic hash (BLAKE2b, 32 bytes output)
SELECT encode(pgsodium.crypto_generichash('data to hash'::bytea), 'hex');

-- With custom key (keyed hash / MAC)
SELECT pgsodium.crypto_generichash('data'::bytea, pgsodium.randombytes_buf(32));
```

### Key Generation & Random Data

```sql
-- Generate 32 random bytes (hex)
SELECT encode(pgsodium.randombytes_buf(32), 'hex');

-- Create named key in key management table
SELECT * FROM pgsodium.create_key(name := 'my_app_key');

-- View all valid (non-expired) keys
SELECT * FROM pgsodium.valid_key;
```

### Key Derivation (Requires Preloading)

Derive keys from the server root key. **Requires pgsodium in shared_preload_libraries**.

```sql
-- Derive key from server root key
-- key_id=1, size=32 bytes, context=8 bytes exactly
SELECT pgsodium.derive_key(1, 32, 'pgsodium'::bytea);
```

### AEAD Deterministic Encryption

Authenticated Encryption with Associated Data (deterministic variant for TCE).

```sql
-- Generate AEAD key
SELECT pgsodium.crypto_aead_det_keygen() AS key;

-- Encrypt with associated data
SELECT pgsodium.crypto_aead_det_encrypt(
  'message'::bytea,           -- plaintext
  'additional data'::bytea,   -- AAD (authenticated but not encrypted)
  pgsodium.crypto_aead_det_keygen()
);
```

### Transparent Column Encryption (TCE)

Automatically encrypt/decrypt columns using PostgreSQL security labels.

```sql
-- Step 1: Create a key for encryption
SELECT * FROM pgsodium.create_key(name := 'users_ssn_key') AS key_id \gset

-- Step 2: Create table with column to encrypt
CREATE TABLE private.users (
  id bigserial PRIMARY KEY,
  name text,
  ssn text  -- will be encrypted transparently
);

-- Step 3: Apply security label
SECURITY LABEL FOR pgsodium ON COLUMN private.users.ssn
  IS 'ENCRYPT WITH KEY ID :"key_id"';

-- Step 4: Use normally - encryption/decryption is automatic
INSERT INTO private.users (name, ssn) VALUES ('John', '123-45-6789');
SELECT * FROM private.users;  -- Returns decrypted values
SELECT * FROM private.decrypted_users;  -- Decrypted view (if exists)
```

### Using with supabase_vault

Store and retrieve encrypted secrets using supabase_vault extension.

```sql
-- Store secret (encrypted at rest)
SELECT vault.create_secret('sk_live_xxx', 'stripe_api_key', 'Production Stripe key');

-- Retrieve decrypted secret
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_api_key';

-- List all secrets (encrypted values)
SELECT id, name, description, created_at FROM vault.secrets;

-- Update secret value
UPDATE vault.secrets
SET secret = vault.encrypt_secret('new_key_value')
WHERE name = 'stripe_api_key';
```

### Password Hashing (Argon2)

Secure password hashing using Argon2i algorithm.

```sql
-- Hash a password (returns string suitable for storage)
SELECT pgsodium.crypto_pwhash_str('user_password_here');

-- Verify password against stored hash
SELECT pgsodium.crypto_pwhash_str_verify(
  stored_hash,        -- from database
  'user_input'        -- user's login attempt
);
```

---

## Security Considerations

1. **Back up the root key** (`$PGDATA/pgsodium_root.key` or your `PGSODIUM_KEY_FILE`): losing it loses every value encrypted under it, and `pg_dump` does not carry it
2. **Never commit a key file** to version control; mount it read-only
3. **Move off the published key** if the container log warns about it (see Rotating the Published Key)

---

## Troubleshooting

| Error                                                                          | Cause                                    | Solution                                               |
| ------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------ |
| `no server secret key defined`                                                 | pgsodium or supabase_vault not preloaded | Keep both in `POSTGRES_SHARED_PRELOAD_LIBRARIES`       |
| `ERROR: PGSODIUM_KEY_FILE=... must be readable ...`                            | Wrong path, permissions or content       | Fix the file: 64 hex characters, readable by postgres  |
| `pgsodium_getkey: ... must hold 64 hex characters`                             | Key file corrupted                       | Restore the key file from your backup                  |
| `...pgsodium_root.key is missing, but this data directory was created with it` | Key file deleted                         | Restore it from your backup                            |
| `this data directory was created with PGSODIUM_KEY_FILE, which is not set now` | Variable removed                         | Set it to the same key file                            |
| `...created with your own pgsodium_getkey, which is not mounted now`           | Mount removed                            | Mount the same script again                            |
| `crypto_kdf_derive_from_key: context must be 8 bytes`                          | Wrong context parameter                  | Use exactly 8-byte context (e.g., `'pgsodium'::bytea`) |
| `pgsodium.key table empty`                                                     | Init script didn't run                   | Set `ENABLE_PGSODIUM_INIT=true`                        |

---

## References

### pgsodium Documentation

- [pgsodium GitHub Repository](https://github.com/michelp/pgsodium) - Source code and examples
- [Server Key Management](https://michelp.github.io/pgsodium/Server_Key_Management.html) - Key setup guide
- [Transparent Column Encryption (TCE)](https://michelp.github.io/pgsodium/TCE.html) - TCE patterns and examples
- [getkey_scripts Examples](https://github.com/michelp/pgsodium/tree/main/getkey_scripts) - Production key management scripts

### supabase_vault Documentation

- [Supabase Vault Documentation](https://supabase.com/docs/guides/database/vault) - Official vault guide

### libsodium (Underlying Crypto Library)

- [libsodium Documentation](https://doc.libsodium.org/) - Algorithm reference

### Coolify Integration

- [Coolify Persistent Storage](https://coolify.io/docs/knowledge-base/persistent-storage) - Volume/bind mount guide
- [Coolify Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose) - Compose with file content
- [PostgreSQL 18 Volume Issue](https://github.com/coollabsio/coolify/issues/7279) - Mount path fix
