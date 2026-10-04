#!/usr/bin/env bun
/**
 * supautils (optional preload) owner: the only suite that boots the image with supautils loaded.
 *
 * - Loaded: the server starts with no supautils FATAL/WARNING in its log, and
 *   `supautils.reserved_roles` stops a non-superuser with CREATEROLE + ADMIN OPTION from altering a
 *   reserved role. The same ALTER succeeding once the role is unreserved proves supautils, not core
 *   permissions, did the blocking; setting it through ALTER SYSTEM + reload also proves the GUC is
 *   reloadable (sighup), as operators configure it.
 * - Not loaded (image default): no supautils GUC exists, so it is not active by default.
 *
 * Usage: bun scripts/test/test-supautils-functional.ts [image] [--image=TAG]
 */
import { $ } from "bun";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";
import { getSharedPreloadLibraries } from "./lib/test-mode";

const image = resolveImageTag();
const withSupautils = generateUniqueContainerName("aza-pg-supautils");
const withoutSupautils = generateUniqueContainerName("aza-pg-supautils-off");

async function sql(
  container: string,
  ...commands: string[]
): Promise<{ ok: boolean; out: string }> {
  const args = commands.flatMap((c) => ["-c", c]);
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tA ${args}`
    .quiet()
    .nothrow();
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}

async function must(container: string, ...commands: string[]): Promise<string> {
  const r = await sql(container, ...commands);
  if (!r.ok) throw new Error(`${commands.join("; ")}\n${r.out}`);
  return r.out;
}

/** reserved_roles is sighup-scoped: wait until a new session sees the reloaded value. */
async function setReservedRoles(value: string | null): Promise<void> {
  await must(
    withSupautils,
    value === null
      ? "ALTER SYSTEM RESET supautils.reserved_roles"
      : `ALTER SYSTEM SET supautils.reserved_roles = '${value}'`,
    "SELECT pg_reload_conf()"
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await must(withSupautils, "SHOW supautils.reserved_roles")) === (value ?? "")) return;
    await Bun.sleep(100);
  }
  throw new Error(`supautils.reserved_roles did not reload to '${value ?? ""}'`);
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
  const preload = `${getSharedPreloadLibraries("production")},supautils`;
  await Promise.all([
    $`docker run -d --name ${withSupautils} -e POSTGRES_PASSWORD=postgres -e POSTGRES_SHARED_PRELOAD_LIBRARIES=${preload} ${image}`.quiet(),
    $`docker run -d --name ${withoutSupautils} -e POSTGRES_PASSWORD=postgres ${image}`.quiet(),
  ]);
  await Promise.all([
    waitForPostgres({ container: withSupautils, timeout: 120 }),
    waitForPostgres({ container: withoutSupautils, timeout: 120 }),
  ]);

  await check("supautils loads on PG18 without FATAL or WARNING", async () => {
    const logs = await $`docker logs ${withSupautils}`.quiet().nothrow();
    const text = logs.stdout.toString() + logs.stderr.toString();
    const bad = text
      .split("\n")
      .filter((l) => /(FATAL|WARNING).*supautils|could not load library.*supautils/i.test(l));
    if (bad.length > 0) throw new Error(bad.join("\n"));
    if (!(await must(withSupautils, "SHOW shared_preload_libraries")).includes("supautils")) {
      throw new Error("supautils missing from shared_preload_libraries");
    }
  });

  await check("reserved_roles blocks ALTER ROLE on a reserved role", async () => {
    await must(
      withSupautils,
      "CREATE ROLE t2b_reserved",
      "CREATE ROLE t2b_admin CREATEROLE",
      "GRANT t2b_reserved TO t2b_admin WITH ADMIN OPTION"
    );
    const alter = ["SET ROLE t2b_admin", "ALTER ROLE t2b_reserved CONNECTION LIMIT 5"];
    try {
      await setReservedRoles("t2b_reserved");
      const blocked = await sql(withSupautils, ...alter);
      if (blocked.ok || !blocked.out.includes('"t2b_reserved" is a reserved role')) {
        throw new Error(
          `ALTER ROLE on a reserved role was not blocked by supautils: ${blocked.out}`
        );
      }
      await setReservedRoles(null);
      const allowed = await sql(withSupautils, ...alter);
      if (!allowed.ok) throw new Error(`control ALTER ROLE failed once unreserved: ${allowed.out}`);
    } finally {
      await sql(
        withSupautils,
        "ALTER SYSTEM RESET supautils.reserved_roles",
        "SELECT pg_reload_conf()"
      );
      await sql(withSupautils, "DROP ROLE IF EXISTS t2b_admin", "DROP ROLE IF EXISTS t2b_reserved");
    }
  });

  await check("supautils is not active in the default image", async () => {
    const count = await must(
      withoutSupautils,
      "SELECT count(*) FROM pg_settings WHERE name LIKE 'supautils.%'"
    );
    if (count !== "0") throw new Error(`${count} supautils GUC(s) present without preload`);
  });
} catch (err) {
  failures.push("setup");
  console.error(`FAIL: setup: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${withSupautils} ${withoutSupautils}`.quiet().nothrow();
}
process.exit(failures.length === 0 ? 0 : 1);
