/**
 * escape_password from the PgBouncer entrypoint, run in bash as shipped (the function is cut from the script, not
 * copied). libpq reads `\` as an escape in .pgpass, so '\' must be doubled BEFORE ':' becomes '\:' — the reverse
 * order doubles the backslash it just added and the stored password no longer matches.
 * The primary-stack suite proves the same line end to end (psql logs in from /tmp/.pgpass).
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

const ENTRYPOINT = join(import.meta.dir, "../../stacks/primary/scripts/pgbouncer-entrypoint.sh");
const escapeFunction = (await Bun.file(ENTRYPOINT).text()).match(
  /^escape_password\(\) \{\n[\s\S]*?\n\}\n/m
)?.[0];

function escapePassword(password: string): string {
  if (!escapeFunction) throw new Error(`escape_password() not found in ${ENTRYPOINT}`);
  const proc = Bun.spawnSync(
    [
      "bash",
      "-c",
      `set -euo pipefail\n${escapeFunction}\nescape_password "$1"`,
      "escape",
      password,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString();
}

test("escapes backslash first, then colon", () => {
  expect(escapePassword("a:b\\c\\:d")).toBe("a\\:b\\\\c\\\\\\:d");
});

test("leaves every other character alone", () => {
  expect(escapePassword(`p@ss&w"o'rd$ *%`)).toBe(`p@ss&w"o'rd$ *%`);
});
