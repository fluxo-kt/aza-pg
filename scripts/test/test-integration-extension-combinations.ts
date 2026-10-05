#!/usr/bin/env bun
/**
 * pgsodium root key and supabase_vault, as shipped: no getkey mount and no preload override.
 *
 * Catches: two databases sharing one key (the image once shipped a single published key), a key that
 * changes across restarts (data encrypted before it becomes unreadable), a key file other users can
 * read, PGSODIUM_KEY_FILE being ignored or a key being generated beside it, a malformed operator key
 * file starting a server instead of stopping with its path, a new database ending up with the published key
 * (first start without pgsodium preloaded, or PGSODIUM_KEY_FILE removed later), the image writing a key or
 * warning beside an operator-mounted getkey, ENABLE_PGSODIUM_INIT not creating the
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
import { getSharedPreloadLibraries } from "./lib/test-mode";

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
  // The operator's own getkey (docs/PGSODIUM-SETUP.md): prints the same key as the operator key file.
  const ownGetkey = path.join(keyDir, "getkey");
  await writeFile(ownGetkey, "#!/bin/sh\nexec cat /run/secrets/pgsodium.key\n", { mode: 0o755 });
  const pgMajor = (
    (await $`docker image inspect -f ${"{{json .Config.Env}}"} ${image}`.quiet().json()) as string[]
  )
    .find((e) => e.startsWith("PG_MAJOR="))
    ?.slice("PG_MAJOR=".length);
  if (!pgMajor) throw new Error(`no PG_MAJOR in ${image}`);
  const getkeyPath = `/usr/share/postgresql/${pgMajor}/extension/pgsodium_getkey`;
  // A first start where nothing calls getkey: neither pgsodium nor supabase_vault is preloaded.
  const withoutPgsodium = getSharedPreloadLibraries("production")
    .split(",")
    .filter((lib) => lib !== "pgsodium" && lib !== "supabase_vault")
    .join(",");

  const [a, b, c1, c2, bad, nopre, own] = await Promise.all([
    start("key-a"),
    start("key-b"),
    start("key-c1", [...mount(operatorKey), ...operator, "-e", "ENABLE_PGSODIUM_INIT=true"]),
    start("key-c2", [...mount(operatorKey), ...operator]),
    start("key-bad", [...mount(badKey), ...operator]),
    start("key-nopre", ["-e", `POSTGRES_SHARED_PRELOAD_LIBRARIES=${withoutPgsodium}`]),
    start("key-own", [...mount(operatorKey), "-v", `${ownGetkey}:${getkeyPath}:ro`]),
  ]);
  await Promise.all(
    [a, b, c1, c2, nopre, own].map((container) => waitForPostgres({ container, timeout: 120 }))
  );
  const pgdataFile = async (container: string, name: string) => {
    const r = await $`docker exec ${container} sh -c ${`cat "$PGDATA/${name}"`}`.quiet().nothrow();
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };

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

  await check("a first start without pgsodium preloaded still gets its own key", async () => {
    // Without it the next start took the directory for one made by an older image and wrote the published key.
    const [key, keyA, source] = await Promise.all([
      pgdataFile(nopre, "pgsodium_root.key"),
      pgdataFile(a, "pgsodium_root.key"),
      pgdataFile(nopre, "pgsodium_key_source"),
    ]);
    if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new Error(`key file holds ${key}`);
    if (key === keyA) throw new Error("same key as another new database");
    if (source !== "data directory") throw new Error(`key source record is ${source}`);
  });

  await check(
    "a POSTGRES_SHARED_PRELOAD_LIBRARIES without default libraries is healthy",
    async () => {
      // The healthcheck once demanded every default preload library, so a supported custom list (such as the
      // previous default, without supabase_vault) kept the container unhealthy for good.
      const hc = await $`docker exec ${nopre} /usr/local/bin/healthcheck.sh`.quiet().nothrow();
      if (hc.exitCode !== 0) throw new Error(`healthcheck failed: ${hc.stderr.toString().trim()}`);
      // Skipping must not blind it: an extension that needs no preload and is gone still fails it.
      await sql(nopre, "DROP EXTENSION pg_trgm");
      const dropped = await $`docker exec ${nopre} /usr/local/bin/healthcheck.sh`.quiet().nothrow();
      if (dropped.exitCode === 0 || !dropped.stderr.toString().includes("pg_trgm")) {
        throw new Error(
          `healthcheck did not report the dropped pg_trgm (exit ${dropped.exitCode})`
        );
      }
    }
  );

  await check(
    "an operator-mounted getkey owns the key: none written, no published-key warning",
    async () => {
      const [ownKey, opKey, file, source, logs] = await Promise.all([
        derive(own),
        derive(c1),
        pgdataFile(own, "pgsodium_root.key"),
        pgdataFile(own, "pgsodium_key_source"),
        $`docker logs ${own}`.quiet().nothrow(),
      ]);
      if (ownKey !== opKey) throw new Error("the mounted getkey's key is not the one in use");
      if (file !== null)
        throw new Error("a pgsodium_root.key was written beside the mounted getkey");
      if (source !== "pgsodium_getkey") throw new Error(`key source record is ${source}`);
      if (logs.stderr.toString().includes("older aza-pg images published")) {
        throw new Error("published-key warning despite the operator's getkey");
      }
    }
  );

  await check(
    "a directory created with PGSODIUM_KEY_FILE refuses to start without it",
    async () => {
      // The same data directory (--volumes-from) without the variable: the published key used to replace it.
      await $`docker stop ${c2}`.quiet();
      const unset = await start("key-c2-unset", ["--volumes-from", c2]);
      const code = await Promise.race([
        $`docker wait ${unset}`
          .quiet()
          .nothrow()
          .then((r) => r.text().trim()),
        Bun.sleep(30_000).then(() => "still running after 30s"),
      ]);
      const logs = (await $`docker logs ${unset}`.quiet().nothrow()).stderr.toString();
      if (code !== "1") throw new Error(`exit code ${code}, want 1`);
      if (!logs.includes("created with PGSODIUM_KEY_FILE")) {
        throw new Error(`log does not name PGSODIUM_KEY_FILE:\n${logs.slice(-500)}`);
      }
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
  // Newest first, one command: key-c2-unset borrows key-c2's volume, which goes with key-c2 only once unused.
  await $`docker rm -f -v ${containers.toReversed()}`.quiet().nothrow();
  await rm(keyDir, { recursive: true, force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
