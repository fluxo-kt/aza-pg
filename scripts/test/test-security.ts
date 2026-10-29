#!/usr/bin/env bun
/**
 * Security defaults of the image: password hashing, client authentication, network binding and
 * schema privileges, each asserted by what a client experiences rather than by a setting's name.
 *
 * Two containers start in parallel: one with no POSTGRES_BIND_IP (the entrypoint default) and one
 * with POSTGRES_BIND_IP=0.0.0.0, the only one reachable on a non-loopback address. Loopback TCP is
 * `trust` in pg_hba (the official image's initdb default), so password authentication can only be
 * observed through the container's own network address.
 *
 * Usage: POSTGRES_IMAGE=<ref> bun test ./scripts/test/test-security.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { EPHEMERAL_PGDATA, generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

// argv is NOT passed: under `bun test` it holds the test runner's own arguments, not an image.
const IMAGE = resolveImageTag({ argv: [] });
const PASSWORD = "secureTestPass123!";
const DEFAULT_CONTAINER = generateUniqueContainerName("aza-pg-security-default");
const NETWORK_CONTAINER = generateUniqueContainerName("aza-pg-security-network");

async function startContainer(name: string, env: string[]): Promise<void> {
  const flags = env.flatMap((e) => ["-e", e]);
  const run =
    await $`docker run -d --name ${name} ${EPHEMERAL_PGDATA} -e POSTGRES_PASSWORD=${PASSWORD} ${flags} ${IMAGE}`
      .quiet()
      .nothrow();
  if (run.exitCode !== 0) throw new Error(`docker run ${name} failed: ${run.stderr.toString()}`);
  await waitForPostgres({ container: name, timeout: TIMEOUTS.startup });
}

async function sql(
  container: string,
  query: string,
  user = "postgres"
): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await $`docker exec ${container} psql -X -U ${user} -d postgres -tAc ${query}`
    .quiet()
    .nothrow();
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

beforeAll(
  async () => {
    await Promise.all([
      startContainer(DEFAULT_CONTAINER, []),
      startContainer(NETWORK_CONTAINER, ["POSTGRES_BIND_IP=0.0.0.0"]),
    ]);
  },
  (TIMEOUTS.startup + TIMEOUTS.health) * 1000
);

afterAll(async () => {
  await $`docker rm -f -v ${DEFAULT_CONTAINER} ${NETWORK_CONTAINER}`.quiet().nothrow();
}, 30_000);

describe("Authentication", () => {
  // initdb stores the superuser's password with its own default, so only a password set on the running server shows
  // what the image's configuration does; the network login below cannot see an md5 setting.
  test("a password set on the running server is stored as a SCRAM-SHA-256 verifier", async () => {
    const created = await sql(DEFAULT_CONTAINER, "CREATE ROLE scram_probe LOGIN PASSWORD 'probe'");
    expect(created.err).toBe("");
    const stored = await sql(
      DEFAULT_CONTAINER,
      "SELECT left(rolpassword, 14) FROM pg_authid WHERE rolname = 'scram_probe'"
    );
    await sql(DEFAULT_CONTAINER, "DROP ROLE scram_probe");
    expect(stored.out).toBe("SCRAM-SHA-256$");
  });

  test("every pg_hba rule for non-loopback clients requires scram-sha-256", async () => {
    const hba = await $`docker exec ${DEFAULT_CONTAINER} sh -c ${'cat "$PGDATA/pg_hba.conf"'}`
      .quiet()
      .nothrow();
    expect(hba.exitCode).toBe(0);
    const networkRules = hba.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("host") && !/127\.0\.0\.1\/32|::1\/128/.test(line));
    expect(networkRules.length).toBeGreaterThan(0);
    for (const rule of networkRules) expect(rule).toMatch(/scram-sha-256$/);
  });

  test("TCP login from the network rejects a wrong password and accepts the right one", async () => {
    // The container's IPv4 bridge address: listen_addresses=0.0.0.0 does not cover IPv6.
    const address = (
      await $`docker inspect -f ${"{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"} ${NETWORK_CONTAINER}`.quiet()
    )
      .text()
      .trim()
      .split(" ")[0];
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const login = (password: string) =>
      $`docker exec -e PGPASSWORD=${password} ${NETWORK_CONTAINER} psql -X -h ${address} -U postgres -d postgres -tAc ${"SELECT 1"}`
        .quiet()
        .nothrow();
    const wrong = await login("not-the-password");
    expect(wrong.exitCode).not.toBe(0);
    expect(wrong.stderr.toString()).toContain('password authentication failed for user "postgres"');
    const right = await login(PASSWORD);
    expect(right.stderr.toString()).toBe("");
    expect(right.stdout.toString().trim()).toBe("1");
  });
});

describe("Network binding", () => {
  test("with no POSTGRES_BIND_IP the server listens on loopback only", async () => {
    const result = await sql(DEFAULT_CONTAINER, "SHOW listen_addresses");
    expect(result.out).toBe("127.0.0.1");
  });

  test("POSTGRES_BIND_IP=0.0.0.0 listens on all interfaces", async () => {
    const result = await sql(NETWORK_CONTAINER, "SHOW listen_addresses");
    expect(result.out).toBe("0.0.0.0");
  });
});

describe("Privileges", () => {
  test("a non-superuser cannot create objects in the public schema", async () => {
    const role = "test_public_create_role";
    await sql(DEFAULT_CONTAINER, `DROP ROLE IF EXISTS ${role}`);
    expect((await sql(DEFAULT_CONTAINER, `CREATE ROLE ${role} LOGIN`)).ok).toBe(true);
    try {
      const attempt = await sql(
        DEFAULT_CONTAINER,
        "CREATE TABLE public.test_public_create (id int)",
        role
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.err).toContain("permission denied for schema public");
    } finally {
      await sql(DEFAULT_CONTAINER, "DROP TABLE IF EXISTS public.test_public_create");
      await sql(DEFAULT_CONTAINER, `DROP ROLE IF EXISTS ${role}`);
    }
  });
});
