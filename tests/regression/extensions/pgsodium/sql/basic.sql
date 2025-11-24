--
-- pgsodium - Basic regression test
-- Tests basic cryptographic functions
--
-- Create extension
CREATE EXTENSION IF NOT EXISTS pgsodium;


-- Test crypto_generichash (deterministic hashing)
SELECT
  length(pgsodium.crypto_generichash ('test data'));


-- Test key generation (output length only, not actual key)
SELECT
  length(pgsodium.crypto_secretbox_keygen ());


-- Test nonce generation (output length only)
SELECT
  length(pgsodium.crypto_secretbox_noncegen ());


-- Test encryption/decryption round-trip
WITH
  keys AS (
    SELECT
      pgsodium.crypto_secretbox_keygen () AS key,
      pgsodium.crypto_secretbox_noncegen () AS nonce
  )
SELECT
  convert_from(
    pgsodium.crypto_secretbox_open (pgsodium.crypto_secretbox ('secret'::bytea, nonce, key), nonce, key),
    'utf8'
  ) AS decrypted
FROM
  keys;