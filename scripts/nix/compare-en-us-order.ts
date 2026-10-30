#!/usr/bin/env bun
/**
 * Does en_US.utf8 sort the same under two images' glibc? `bun scripts/nix/compare-en-us-order.ts <old-image> <new-image>`
 *
 * The entrypoint's first start only records a new glibc version for en_US between versions listed in its "same"
 * array; any other change rebuilds every libc-collated index. A version joins that list only when this prints "same":
 * a wrong entry leaves text indexes silently missing rows. Run it in the /update round that changes glibc.
 *
 * PostgreSQL itself sorts (coreutils sort disagrees with it across these images, so it is no stand-in): every code
 * point, plus 490,000 pairs, ordered by en_US.utf8 with ties broken by C so equal-weight strings cannot hide a change.
 */

import {
  EPHEMERAL_PGDATA,
  dockerCleanup,
  generateUniqueContainerName,
  waitForPostgres,
} from "../utils/docker";

const ORDER_SQL = `CREATE TEMP TABLE c AS SELECT chr(i) AS s FROM generate_series(32, 1114111) i
  WHERE i NOT BETWEEN 55296 AND 57343 AND i NOT BETWEEN 127 AND 159;
INSERT INTO c SELECT a.s || b.s FROM (SELECT s FROM c ORDER BY md5(s) LIMIT 700) a, (SELECT s FROM c ORDER BY md5(s || 'x') LIMIT 700) b;
SELECT (SELECT collversion FROM pg_collation WHERE collname = 'en_US.utf8') || ' ' || count(*) || ' '
  || md5(string_agg(s, '|' ORDER BY s COLLATE "en_US.utf8", s COLLATE "C")) FROM c;`;

async function measure(image: string): Promise<string> {
  const container = generateUniqueContainerName("aza-pg-en-us-order");
  try {
    const run = Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--name",
        container,
        ...EPHEMERAL_PGDATA,
        "-e",
        "POSTGRES_PASSWORD=x",
        image,
      ],
      {
        stdout: "ignore",
        stderr: "inherit",
      }
    );
    if ((await run.exited) !== 0) throw new Error(`${image}: docker run failed`);
    await waitForPostgres({ container, timeout: 120 });
    const psql = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        container,
        "psql",
        "-XqAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-f",
        "-",
      ],
      {
        stdin: new TextEncoder().encode(ORDER_SQL),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [out, err, code] = await Promise.all([
      new Response(psql.stdout).text(),
      new Response(psql.stderr).text(),
      psql.exited,
    ]);
    if (code !== 0) throw new Error(`${image}: ${err.trim()}`);
    return out.trim().split("\n").at(-1) ?? "";
  } finally {
    await dockerCleanup(container);
  }
}

const images = Bun.argv.slice(2);
if (images.length !== 2) {
  console.error("Usage: bun scripts/nix/compare-en-us-order.ts <old-image> <new-image>");
  process.exit(64);
}
const [a, b] = await Promise.all(images.map(measure));
console.log(`${images[0]}: glibc ${a}\n${images[1]}: glibc ${b}`);
const same = a!.split(" ").slice(1).join(" ") === b!.split(" ").slice(1).join(" ");
console.log(
  same
    ? "same en_US.utf8 order: both versions may stand in the entrypoint's list"
    : "en_US.utf8 order DIFFERS: keep the new version out of the list"
);
process.exit(same ? 0 : 1);
