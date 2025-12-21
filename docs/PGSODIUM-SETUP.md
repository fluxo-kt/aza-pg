# pgsodium & Vault Setup Guide

Production setup guide for pgsodium Transparent Column Encryption (TCE) and supabase_vault.

## Quick Start

### Required Configuration

For full vault encryption functionality, you need:

1. **pgsodium_getkey script** at `/usr/share/postgresql/18/extension/pgsodium_getkey`
2. **Both extensions in shared_preload_libraries**: `pgsodium,supabase_vault`
3. **ENABLE_PGSODIUM_INIT=true** environment variable

```bash
# Docker run example
docker run -d \
  -v /path/to/your/pgsodium_getkey:/usr/share/postgresql/18/extension/pgsodium_getkey:ro \
  -e POSTGRES_PASSWORD=secure_password \
  -e POSTGRES_SHARED_PRELOAD_LIBRARIES="pg_stat_statements,pgsodium,supabase_vault" \
  -e ENABLE_PGSODIUM_INIT=true \
  ghcr.io/fluxo-kt/aza-pg:18.1-YYYYMMDD-single-node
```

### Docker Compose Example

```yaml
services:
  postgres:
    image: ghcr.io/fluxo-kt/aza-pg:18.1-YYYYMMDD-single-node
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_SHARED_PRELOAD_LIBRARIES: "pg_stat_statements,pgsodium,supabase_vault"
      ENABLE_PGSODIUM_INIT: "true"
    volumes:
      - ./secrets/pgsodium_getkey:/usr/share/postgresql/18/extension/pgsodium_getkey:ro
      - postgres_data:/var/lib/postgresql/data
```

---

## Coolify Deployment

Deploy aza-pg with pgsodium on [Coolify](https://coolify.io) using either Docker Compose (recommended) or direct database deployment.

### Prerequisites

- Coolify instance running
- Understanding of [pgsodium_getkey script](#pgsodium_getkey-script) requirements
- **CRITICAL**: PostgreSQL 18+ requires volume mount at `/var/lib/postgresql` (NOT `/var/lib/postgresql/data`)

### Method 1: Docker Compose (Recommended)

Coolify's Docker Compose deployment supports inline file content, simplifying pgsodium_getkey setup.

**Steps:**

1. In Coolify: **Projects** → **+ New** → **Docker Compose**
2. Paste the following `compose.yml`:

```yaml
services:
  postgres:
    image: ghcr.io/fluxo-kt/aza-pg:18
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_MEMORY: ${POSTGRES_MEMORY:-2048}
      POSTGRES_SHARED_PRELOAD_LIBRARIES: "pg_stat_statements,pgsodium,supabase_vault"
      ENABLE_PGSODIUM_INIT: "true"
    volumes:
      - type: volume
        source: postgres_data
        target: /var/lib/postgresql
      - type: bind
        source: ./pgsodium_getkey
        target: /usr/share/postgresql/18/extension/pgsodium_getkey
        read_only: true
        content: |
          #!/bin/sh
          # PRODUCTION: Replace with actual secret management (AWS Secrets Manager, Vault, etc.)
          # For now, generate a key: openssl rand -hex 32
          echo "YOUR_64_HEX_CHAR_KEY_HERE"

volumes:
  postgres_data:
```

3. Set environment variable `POSTGRES_PASSWORD` in Coolify's **Environment** tab
4. **Deploy**

**Generate a secure key:**

```bash
openssl rand -hex 32
```

### Method 2: Direct Database Deployment

For deploying via Coolify's **Databases** → **PostgreSQL** interface:

**Steps:**

1. **Create Database:**
   - **Databases** → **PostgreSQL** → **+ New Database**
   - **Image**: `ghcr.io/fluxo-kt/aza-pg:18`

2. **Fix Volume Path (CRITICAL):**
   - Navigate to **Configuration** → **Persistent Storage**
   - Change **Destination Path** from `/var/lib/postgresql/data` to `/var/lib/postgresql`
   - See [PostgreSQL 18 Volume Issue](https://github.com/coollabsio/coolify/issues/7279) for details

3. **Create pgsodium_getkey Script on Host:**

   SSH into your Coolify server:

   ```bash
   mkdir -p /opt/coolify/pgsodium
   cat > /opt/coolify/pgsodium/pgsodium_getkey << 'EOF'
   #!/bin/sh
   # Generate key: openssl rand -hex 32
   echo "YOUR_64_HEX_CHAR_KEY_HERE"
   EOF
   chmod +x /opt/coolify/pgsodium/pgsodium_getkey
   ```

4. **Add Bind Mount in Coolify UI:**
   - **Configuration** → **Persistent Storage** → **+ Add**
   - **Type**: Bind Mount
   - **Source Path**: `/opt/coolify/pgsodium/pgsodium_getkey`
   - **Destination Path**: `/usr/share/postgresql/18/extension/pgsodium_getkey`

5. **Set Environment Variables:**

   Navigate to **Configuration** → **Environment**:

   | Variable                            | Value                                        | Purpose        |
   | ----------------------------------- | -------------------------------------------- | -------------- |
   | `POSTGRES_PASSWORD`                 | (strong password)                            | Required       |
   | `POSTGRES_MEMORY`                   | (match limit, e.g., `2048`)                  | Auto-tuning    |
   | `POSTGRES_SHARED_PRELOAD_LIBRARIES` | `pg_stat_statements,pgsodium,supabase_vault` | For vault      |
   | `ENABLE_PGSODIUM_INIT`              | `true`                                       | For vault      |
   | `POSTGRES_BIND_IP`                  | `0.0.0.0`                                    | Network access |

6. **Restart Database**

### Verification via Coolify Terminal

1. Navigate to your database in Coolify
2. Open the **Terminal** tab
3. Run: `psql -U postgres`
4. Execute verification SQL:

```sql
-- Check server key loaded (should see in container logs)
-- LOG: pgsodium primary server secret key loaded
-- LOG: vault primary server secret key loaded

-- Test pgsodium
SELECT pgsodium.derive_key(1, 32, 'pgsodium'::bytea);

-- Test vault
SELECT vault.create_secret('test_value', 'test_key', 'Test secret');
SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'test_key';
```

### Coolify-Specific Troubleshooting

| Issue                                  | Cause                     | Solution                                                                   |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| Container exits `unhealthy`            | Wrong volume path         | Change Persistent Storage destination to `/var/lib/postgresql`             |
| `no server secret key defined`         | getkey script not mounted | Add bind mount for `pgsodium_getkey`                                       |
| `FATAL: getkey script not found`       | Wrong mount path          | Verify destination is `/usr/share/postgresql/18/extension/pgsodium_getkey` |
| `Permission denied` executing getkey   | Script not executable     | Ensure `chmod +x` on host file                                             |
| `Using /proc/meminfo fallback` warning | No cgroup limit detected  | Set `POSTGRES_MEMORY` to match Coolify's memory limit                      |

**Additional Resources:**

- [Coolify DEPLOYMENT.md](COOLIFY.md) - Full aza-pg deployment guide
- [Coolify Persistent Storage](https://coolify.io/docs/knowledge-base/persistent-storage)
- [Coolify Docker Compose](https://coolify.io/docs/knowledge-base/docker/compose)

---

## pgsodium_getkey Script

The getkey script provides the 32-byte server root key used for key derivation. **This key is never exposed to SQL** - it's loaded into process memory at startup.

### Script Requirements

- **Location**: `/usr/share/postgresql/18/extension/pgsodium_getkey`
- **Permissions**: Executable (`chmod +x`)
- **Output**: 64 hexadecimal characters (32 bytes)
- **Exit code**: 0 on success

### Example Scripts

#### Development/Testing (DO NOT USE IN PRODUCTION)

```bash
#!/bin/sh
# Test key - replace with secure key management in production
echo "4670bdf714d653c15779e67e0bb6012f1e229c86edbdf75285f3c592670cece2"
```

#### Production: AWS Secrets Manager

```bash
#!/bin/sh
set -euo pipefail
aws secretsmanager get-secret-value \
  --secret-id pgsodium/server-key \
  --query SecretString \
  --output text
```

#### Production: HashiCorp Vault

```bash
#!/bin/sh
set -euo pipefail
curl -s -H "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/secret/data/pgsodium/server-key" | \
  jq -r '.data.data.key'
```

#### Production: File-based with Key Generation

```bash
#!/bin/sh
set -euo pipefail
KEY_FILE="/var/lib/postgresql/pgsodium_root.key"
if [ ! -f "$KEY_FILE" ]; then
    # Generate new key (first run only)
    head -c 32 /dev/urandom | od -A n -t x1 | tr -d ' \n' > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
fi
cat "$KEY_FILE"
```

### Generating a New Key

```sql
-- In PostgreSQL (requires pgsodium extension)
SELECT encode(pgsodium.randombytes_buf(32), 'hex');
```

---

## Why Both Extensions Need Preloading

### pgsodium Preloading

When `pgsodium` is in `shared_preload_libraries`:

- Reads server key from `pgsodium.getkey_script` during `_PG_init()`
- Stores key in shared memory for all backends
- Enables `pgsodium.derive_key()` and TCE functions
- Registers `pgsodium.enable_event_trigger` GUC parameter

### supabase_vault Preloading

When `supabase_vault` is in `shared_preload_libraries`:

- Has its **own** `_PG_init()` that loads the same server key
- Uses the key for `vault._crypto_aead_det_encrypt()` calls
- **Without preloading**: `vault.create_secret()` fails with "no server secret key defined"

### Common Mistake

```bash
# WRONG: Only preloading pgsodium
POSTGRES_SHARED_PRELOAD_LIBRARIES="pgsodium"
# vault.create_secret() will fail!

# CORRECT: Preload both
POSTGRES_SHARED_PRELOAD_LIBRARIES="pgsodium,supabase_vault"
```

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

1. **Never commit the getkey script with hardcoded keys** to version control
2. **Use secret management** (AWS Secrets Manager, HashiCorp Vault, etc.) in production
3. **Backup the root key** - losing it means losing access to all encrypted data
4. **Rotate keys carefully** - pgsodium supports key rotation but requires planning
5. **Mount getkey script read-only** (`:ro`) to prevent modification

---

## Troubleshooting

| Error                                                 | Cause                   | Solution                                               |
| ----------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `no server secret key defined`                        | Extension not preloaded | Add to `shared_preload_libraries`                      |
| `FATAL: getkey script not found`                      | Missing getkey script   | Volume mount the script                                |
| `crypto_kdf_derive_from_key: context must be 8 bytes` | Wrong context parameter | Use exactly 8-byte context (e.g., `'pgsodium'::bytea`) |
| `pgsodium.key table empty`                            | Init script didn't run  | Set `ENABLE_PGSODIUM_INIT=true`                        |

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
