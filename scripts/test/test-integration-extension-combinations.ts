#!/usr/bin/env bun
/**
 * pgsodium + supabase_vault encryption stack, as operators enable it: the repository's test
 * pgsodium_getkey fixture mounted into the image, ENABLE_PGSODIUM_INIT=true, and supabase_vault
 * preloaded so it reads the server key at startup.
 *
 * Catches: the init script not creating the pgsodium root key, vault failing to encrypt or decrypt
 * with the server key, and — the costly silent one — a secret stored in plaintext.
 *
 * Usage: bun scripts/test/test-integration-extension-combinations.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import path from "node:path";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { getSharedPreloadLibraries } from "./lib/test-mode";

const image = resolveImageTag();
const container = generateUniqueContainerName("aza-pg-vault");
const GETKEY_FIXTURE = path.join(import.meta.dir, "../../tests/fixtures/pgsodium/pgsodium_getkey");
const PLAINTEXT = "sk_test_t2b_1234567890abcdef";

async function sql(query: string): Promise<string> {
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA -c ${query}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) throw new Error(`${query}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  // pgsodium looks for the getkey script in the image's extension directory; ask the image where
  // that is instead of hard-coding the PostgreSQL major version.
  const sharedir = (await $`docker run --rm --entrypoint pg_config ${image} --sharedir`.quiet())
    .text()
    .trim();
  const preload = `${getSharedPreloadLibraries("production")},supabase_vault`;
  await $`docker run -d --name ${container} -v ${GETKEY_FIXTURE}:${sharedir}/extension/pgsodium_getkey:ro -e POSTGRES_PASSWORD=postgres -e ENABLE_PGSODIUM_INIT=true -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${preload} ${image}`.quiet();
  await waitForPostgres({ container, timeout: 120 });

  await check("pgsodium init creates the server root key", async () => {
    const keys = await sql("SELECT count(*) FROM pgsodium.key WHERE name = 'pgsodium_root'");
    if (keys !== "1") throw new Error(`pgsodium_root keys: ${keys}`);
  });

  await check("vault round-trips a secret and stores it encrypted", async () => {
    await sql("CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE");
    await sql(`SELECT vault.create_secret('${PLAINTEXT}', 't2b_api_key')`);
    const decrypted = await sql(
      "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 't2b_api_key'"
    );
    if (decrypted !== PLAINTEXT) throw new Error(`decrypted secret is "${decrypted}"`);
    const raw = await sql("SELECT secret FROM vault.secrets WHERE name = 't2b_api_key'");
    if (raw === "" || raw.includes(PLAINTEXT)) {
      throw new Error(`secret column is not ciphertext: "${raw}"`);
    }
  });
} catch (err) {
  failures.push("setup");
  console.error(`FAIL: setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${container}`.quiet().nothrow();
}
process.exit(failures.length === 0 ? 0 : 1);
