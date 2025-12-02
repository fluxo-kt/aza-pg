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

- [pgsodium Documentation](https://github.com/michelp/pgsodium)
- [pgsodium Server Key Management](https://michelp.github.io/pgsodium/Server_Key_Management.html)
- [Supabase Vault Documentation](https://supabase.com/docs/guides/database/vault)
- [getkey_scripts Examples](https://github.com/michelp/pgsodium/tree/main/getkey_scripts)
