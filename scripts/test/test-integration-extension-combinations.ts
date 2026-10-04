#!/usr/bin/env bun
/**
 * pgsodium root key and supabase_vault, as shipped: no getkey mount and no preload override.
 *
 * Catches: two databases sharing one key (the image once shipped a single published key), a key that
 * changes across restarts (data encrypted before it becomes unreadable), a key file other users can
 * read, PGSODIUM_KEY_FILE being ignored or a key being generated beside it, a malformed operator key
 * file starting a server instead of stopping with its path, ENABLE_PGSODIUM_INIT not creating the
 * root key, and vault failing to encrypt or storing a secret in plaintext under the default preload.
 * pgsodium.derive_key(1) is a function of the root key alone, so equal outputs mean equal keys.
 *
 * Usage: bun scripts/test/test-integration-extension-combinations.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const image = resolveImageTag();
const PLAINTEXT = "sk_test_t2b_1234567890abcdef";
const containers: string[] = [];

async function sql(container: string, query: string): Promise<string> {
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA -c ${query}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) throw new Error(`${query}\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Starts a container with the given extra `docker run` arguments; readiness is the caller's choice. */
async function start(label: string, args: string[] = []): Promise<string> {
  const name = generateUniqueContainerName(`aza-pg-${label}`);
  containers.push(name);
  await $`docker run -d --name ${name} -e POSTGRES_PASSWORD=postgres ${args} ${image}`.quiet();
  return name;
}

const derive = (container: string) =>
  sql(container, "SELECT encode(pgsodium.derive_key(1), 'hex')");

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

const keyDir = await mkdtemp(path.join(tmpdir(), "aza-pgsodium-"));
try {
  const operatorKey = path.join(keyDir, "root.key");
  await writeFile(
    operatorKey,
    `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}\n`,
    { mode: 0o644 }
  );
  const badKey = path.join(keyDir, "bad.key");
  await writeFile(badKey, "not-a-key\n", { mode: 0o644 });
  const mount = (file: string) => ["-v", `${file}:/run/secrets/pgsodium.key:ro`];
  const operator = ["-e", "PGSODIUM_KEY_FILE=/run/secrets/pgsodium.key"];

  const [a, b, c1, c2, bad] = await Promise.all([
    start("key-a"),
    start("key-b"),
    start("key-c1", [...mount(operatorKey), ...operator, "-e", "ENABLE_PGSODIUM_INIT=true"]),
    start("key-c2", [...mount(operatorKey), ...operator]),
    start("key-bad", [...mount(badKey), ...operator]),
  ]);
  await Promise.all(
    [a, b, c1, c2].map((container) => waitForPostgres({ container, timeout: 120 }))
  );

  await check("each new database gets its own private key file", async () => {
    const stat = (
      await $`docker exec ${a} sh -c ${'stat -c %a:%U "$PGDATA/pgsodium_root.key"'}`.quiet()
    )
      .text()
      .trim();
    if (stat !== "600:postgres")
      throw new Error(`key file mode/owner is ${stat}, want 600:postgres`);
    const [da, db] = await Promise.all([derive(a), derive(b)]);
    if (da === db) throw new Error("two new databases derived the same key");
  });

  await check("the key survives a restart", async () => {
    const before = await derive(a);
    await $`docker restart ${a}`.quiet();
    await waitForPostgres({ container: a, timeout: 120 });
    const after = await derive(a);
    if (after !== before) throw new Error("derived key changed across restart");
  });

  await check(
    "PGSODIUM_KEY_FILE is the key in use, and no key is generated beside it",
    async () => {
      const [d1, d2, da] = await Promise.all([derive(c1), derive(c2), derive(a)]);
      if (d1 !== d2)
        throw new Error("two databases given the same key file derived different keys");
      if (d1 === da) throw new Error("operator key file derived the same key as a random default");
      const stray = await $`docker exec ${c1} sh -c ${'test -e "$PGDATA/pgsodium_root.key"'}`
        .nothrow()
        .quiet();
      if (stray.exitCode === 0)
        throw new Error("a pgsodium_root.key was generated despite PGSODIUM_KEY_FILE");
    }
  );

  await check("a malformed PGSODIUM_KEY_FILE stops the container naming the file", async () => {
    // Bounded: an image that ignores PGSODIUM_KEY_FILE keeps running, and an unbounded docker wait would hang
    // the suite instead of failing it. The others are already ready, so a validating entrypoint has exited.
    const code = await Promise.race([
      $`docker wait ${bad}`
        .quiet()
        .nothrow()
        .then((r) => r.text().trim()),
      Bun.sleep(30_000).then(() => "still running after 30s"),
    ]);
    const logs = (await $`docker logs ${bad}`.quiet().nothrow()).stderr.toString();
    if (code !== "1") throw new Error(`exit code ${code}, want 1`);
    if (!logs.includes("PGSODIUM_KEY_FILE=/run/secrets/pgsodium.key")) {
      throw new Error(`log does not name the file:\n${logs.slice(-500)}`);
    }
  });

  await check("ENABLE_PGSODIUM_INIT creates the server root key", async () => {
    const keys = await sql(c1, "SELECT count(*) FROM pgsodium.key WHERE name = 'pgsodium_root'");
    if (keys !== "1") throw new Error(`pgsodium_root keys: ${keys}`);
  });

  await check("vault round-trips a secret and stores it encrypted, on defaults", async () => {
    await sql(a, "CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE");
    await sql(a, `SELECT vault.create_secret('${PLAINTEXT}', 't2b_api_key')`);
    const decrypted = await sql(
      a,
      "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 't2b_api_key'"
    );
    if (decrypted !== PLAINTEXT) throw new Error(`decrypted secret is "${decrypted}"`);
    const raw = await sql(a, "SELECT secret FROM vault.secrets WHERE name = 't2b_api_key'");
    if (raw === "" || raw.includes(PLAINTEXT)) {
      throw new Error(`secret column is not ciphertext: "${raw}"`);
    }
  });
} catch (err) {
  failures.push("setup");
  console.error(`FAIL: setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await Promise.all(containers.map((c) => $`docker rm -f -v ${c}`.quiet().nothrow()));
  await rm(keyDir, { recursive: true, force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
