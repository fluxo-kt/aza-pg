#!/usr/bin/env bun
/**
 * pgBackRest backup and point-in-time-complete restore with the image's own tools.
 *
 * WAL is archived by `archive_command = pgbackrest archive-push`, as an operator configures it, and the restore
 * goes to an EMPTY data volume: rows written AFTER the full backup can only come back by pgBackRest fetching the
 * archived WAL (archive-get) during recovery. So the exact row count proves archive-push, the backup and
 * archive-get together; an archive_command that drops WAL, a backup that cannot be restored or a recovery that
 * stops early each change the count. PostgreSQL must reach the restored cluster through normal recovery —
 * no pg_resetwal, which would start a broken cluster anyway.
 *
 * pgBackRest options come from PGBACKREST_* environment variables, so the server's archive_command and the
 * restore_command pgBackRest writes see the same stanza and paths.
 *
 * Usage: bun scripts/test/test-backup-restore.ts [image]
 */

import { $ } from "bun";
import { TIMEOUTS } from "../config/test-timeouts";
import { generateUniqueContainerName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const image = resolveImageTag();
const run = generateUniqueContainerName("aza-pg-backup");
const source = `${run}-source`;
const restored = `${run}-restored`;
const repoVolume = `${run}-repo`;
const sourceVolume = `${run}-source-data`;
const restoreVolume = `${run}-restore-data`;
const BACKED_UP = 1000;
const AFTER_BACKUP = 234;

const pgdata = (
  await $`docker image inspect -f ${"{{range .Config.Env}}{{println .}}{{end}}"} ${image}`
    .quiet()
    .text()
)
  .split("\n")
  .find((line) => line.startsWith("PGDATA="))
  ?.slice("PGDATA=".length);
const PGBACKREST_ENV = [
  "-e",
  "PGBACKREST_STANZA=main",
  "-e",
  "PGBACKREST_REPO1_PATH=/var/lib/pgbackrest",
  "-e",
  `PGBACKREST_PG1_PATH=${pgdata}`,
  // A broken archive_command fails `check` within this time instead of pgBackRest's 60 s default.
  "-e",
  "PGBACKREST_ARCHIVE_TIMEOUT=15",
];
const SERVER = [
  "-e",
  "POSTGRES_PASSWORD=backup-test",
  "-e",
  "POSTGRES_MEMORY=1024",
  ...PGBACKREST_ENV,
];

async function psql(container: string, sql: string): Promise<string> {
  const r = await $`docker exec ${container} psql -X -v ON_ERROR_STOP=1 -U postgres -tAc ${sql}`
    .nothrow()
    .quiet();
  if (r.exitCode !== 0) throw new Error(`psql exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function pgbackrest(container: string, ...args: string[]): Promise<string> {
  const r = await $`docker exec -u postgres ${container} pgbackrest ${args}`.nothrow().quiet();
  if (r.exitCode !== 0) {
    throw new Error(
      `pgbackrest ${args.join(" ")} exited ${r.exitCode}: ${(r.stdout.toString() + r.stderr.toString()).trim()}`
    );
  }
  return r.stdout.toString();
}

let failed = false;
const started = Date.now();
try {
  if (!pgdata) throw new Error(`no PGDATA in ${image}`);
  console.log(`Backup/restore with ${image}`);

  await $`docker run -d --name ${source} ${SERVER} -v ${sourceVolume}:/var/lib/postgresql -v ${repoVolume}:/var/lib/pgbackrest ${image} postgres -c archive_mode=on -c ${"archive_command=pgbackrest archive-push %p"}`.quiet();
  await waitForPostgres({ container: source, timeout: TIMEOUTS.startup });

  // `check` switches WAL and waits for it to reach the repository: the archive_command must really archive.
  await pgbackrest(source, "stanza-create");
  await pgbackrest(source, "check");
  console.log("✅ stanza created; archive_command delivers WAL to the repository");

  await psql(
    source,
    `CREATE TABLE ledger AS SELECT g AS id FROM generate_series(1, ${BACKED_UP}) g`
  );
  await pgbackrest(source, "backup", "--type=full");
  await psql(
    source,
    `INSERT INTO ledger SELECT g FROM generate_series(${BACKED_UP + 1}, ${BACKED_UP + AFTER_BACKUP}) g`
  );
  // Close the segment holding the post-backup rows and wait until the archiver reports it pushed.
  const segment = await psql(source, "SELECT pg_walfile_name(pg_switch_wal())");
  const deadline = Date.now() + TIMEOUTS.health * 1000;
  let archived = "";
  while (Date.now() < deadline) {
    archived = await psql(source, "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver");
    if (archived >= segment) break;
    await Bun.sleep(250);
  }
  if (archived < segment)
    throw new Error(`WAL ${segment} not archived (last archived: "${archived}")`);
  console.log(`✅ full backup taken; post-backup WAL ${segment} archived`);
  await $`docker stop ${source}`.quiet();

  // Restore into an empty volume, then start the image normally on it.
  const restore =
    await $`docker run --rm -u postgres ${PGBACKREST_ENV} -v ${restoreVolume}:/var/lib/postgresql -v ${repoVolume}:/var/lib/pgbackrest --entrypoint pgbackrest ${image} restore`
      .nothrow()
      .quiet();
  if (restore.exitCode !== 0) {
    throw new Error(
      `pgbackrest restore exited ${restore.exitCode}: ${restore.stdout.toString() + restore.stderr.toString()}`
    );
  }
  await $`docker run -d --name ${restored} ${SERVER} -v ${restoreVolume}:/var/lib/postgresql -v ${repoVolume}:/var/lib/pgbackrest ${image}`.quiet();
  await waitForPostgres({ container: restored, timeout: TIMEOUTS.startup });

  const count = await psql(restored, "SELECT count(*) FROM ledger");
  const logs = await $`docker logs ${restored}`.nothrow().quiet();
  const recovered = /restored log file "[0-9A-F]{24}" from archive/.test(
    logs.stdout.toString() + logs.stderr.toString()
  );
  if (count !== String(BACKED_UP + AFTER_BACKUP) || !recovered) {
    throw new Error(
      `restored ledger has ${count} rows (expected ${BACKED_UP + AFTER_BACKUP}); WAL replayed from archive: ${recovered}`
    );
  }
  console.log(`✅ restore replayed archived WAL: ${count} rows`);
} catch (err) {
  failed = true;
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await $`docker rm -f -v ${source} ${restored}`.nothrow().quiet();
  await $`docker volume rm -f ${repoVolume} ${sourceVolume} ${restoreVolume}`.nothrow().quiet();
}

console.log(`\n${failed ? "FAILED" : "PASSED"} in ${Date.now() - started} ms`);
process.exit(failed ? 1 : 0);
