#!/usr/bin/env bun
/**
 * Promote a running aza-pg standby container to primary (failover).
 *
 * USAGE:
 *   bun scripts/tools/promote-replica.ts [-c NAME] [-d PATH] [-y] [-f]
 *
 * OPTIONS:
 *   -c, --container NAME    Container (default: aza-pg-replica-postgres-replica,
 *                           the replica stack's name under its .env.example's COMPOSE_PROJECT_NAME)
 *   -d, --data-dir PATH     Data directory (default: the container's $PGDATA)
 *   -y, --yes               Skip the confirmation prompt
 *   -f, --force             Promote even while this standby still streams from a live upstream
 *   -n, --no-backup         Accepted for old scripts; the tool takes no backup (see below)
 *   -h, --help              Show this help
 *
 * The old primary MUST be stopped first: two primaries accepting writes is split-brain. The tool refuses while this
 * standby still streams from its upstream (pg_stat_wal_receiver), because that server is visibly alive. Not streaming
 * proves nothing: a primary cut off by a network partition looks the same from here, so stopping it stays the
 * operator's job. Promotion is one-way: this server starts a new timeline, and the old primary can only rejoin as a
 * replica of it (re-clone, or pg_rewind).
 *
 * How it works: `pg_ctl promote` on the running server. pg_ctl refuses a server that is not a standby, then waits
 * until the control file reads "in production" (its -w is the default for promote), so its exit status is the
 * completion signal and no sleep decides readiness. The server keeps running throughout and PostgreSQL removes
 * standby.signal itself, so no restart or file edit is needed. It runs as user postgres because pg_ctl refuses root
 * and the image's USER may be overridden.
 * No backup step: promotion changes no existing data, and a copy of a standby restores nothing the old primary does
 * not also hold; take backups with backup-postgres.ts or pgBackRest.
 */

import { $ } from "bun";
import { error, info, success, warning } from "../utils/logger";

const HELP = `Promote a running aza-pg standby container to primary.

USAGE:
  bun scripts/tools/promote-replica.ts [-c NAME] [-d PATH] [-y] [-f]

OPTIONS:
  -c, --container NAME    Container (default: aza-pg-replica-postgres-replica)
  -d, --data-dir PATH     Data directory (default: the container's $PGDATA)
  -y, --yes               Skip the confirmation prompt
  -f, --force             Promote even while this standby still streams from a live upstream
  -h, --help              Show this help

Stop the old primary first: two primaries is split-brain. The tool refuses while this standby still streams from
its upstream; not streaming does not prove the old primary is down. Promotion is one-way.
`;

function fail(message: string): never {
  error(message);
  process.exit(1);
}

function parseArgs(args: string[]) {
  let container = "aza-pg-replica-postgres-replica";
  let dataDir = "";
  let yes = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => args[++i] ?? fail(`Missing value for ${arg}`);
    switch (arg) {
      case "-c":
      case "--container":
        container = value();
        break;
      case "-d":
      case "--data-dir":
        dataDir = value();
        break;
      case "-y":
      case "--yes":
        yes = true;
        break;
      case "-f":
      case "--force":
        force = true;
        break;
      case "-n":
      case "--no-backup":
        break;
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
      default:
        fail(`Unknown option: ${arg}. Use -h for help.`);
    }
  }
  return { container, dataDir, yes, force };
}

const { container, dataDir, yes, force } = parseArgs(Bun.argv.slice(2));
const dataDirArgs = dataDir ? ["-D", dataDir] : [];

// Checked before the confirmation prompt so an operator is never asked to confirm a promotion pg_ctl would refuse.
// The state comes from the control file, the same field pg_ctl promote checks, so it needs no database login and
// names a stopped or non-standby server correctly even where a login would fail. LC_ALL=C keeps pg_controldata's
// labels in English whatever locale the container runs.
const control =
  await $`docker exec -u postgres -e LC_ALL=C ${container} pg_controldata ${dataDirArgs}`
    .nothrow()
    .quiet();
const state = /^Database cluster state:\s*(.+)$/m.exec(control.stdout.toString())?.[1];
if (state === "in production") fail(`'${container}' is already a primary`);
if (state !== "in archive recovery")
  fail(
    `'${container}' is not a running standby (cluster state: ${state ?? "unreadable — is the container running? docker ps -a"})`
  );

// A standby still streaming has a live upstream, so promoting it now gives two servers accepting writes. The login
// resolves the superuser like the image's healthcheck (POSTGRES_USER, else its _FILE, else postgres) because
// POSTGRES_USER can rename it; the shell script is a plain string and the SQL its $1, so nothing is quoted by hand.
// A status that cannot be read counts as unsafe: refusing costs a --force, a wrong promotion costs diverged data.
const ASK_AS_SUPERUSER =
  'u="${POSTGRES_USER:-}"; if [ -z "$u" ] && [ -n "${POSTGRES_USER_FILE:-}" ]; then u="$(cat "$POSTGRES_USER_FILE")"; fi; exec psql -X -At -U "${u:-postgres}" -d postgres -c "$1"';
const RECEIVER_SQL =
  "SELECT status || ' from ' || coalesce(sender_host, 'unknown host') FROM pg_stat_wal_receiver";
if (!force) {
  const receiver =
    await $`docker exec -u postgres ${container} sh -c ${ASK_AS_SUPERUSER} sh ${RECEIVER_SQL}`
      .nothrow()
      .quiet();
  if (receiver.exitCode !== 0)
    fail(
      `cannot read the replication status of '${container}': ${receiver.stderr.toString().trim()}\nStop the old primary, then rerun with --force.`
    );
  const status = receiver.stdout.toString().trim();
  if (status.startsWith("streaming"))
    fail(
      `'${container}' is still ${status}: that server is alive, so promoting gives two primaries (split-brain).\nStop it and rerun once this standby no longer streams; --force promotes anyway.`
    );
  warning(
    "Not streaming from a primary. That does not prove it is down: one cut off by a network split looks the same."
  );
}

if (!yes) {
  warning(`About to promote '${container}' to primary. This is one-way.`);
  warning("The old primary MUST already be stopped, or both will accept writes (split-brain).");
  const answer = prompt("Type 'yes' to continue:");
  // prompt() returns null at EOF. Non-zero, so `promote-replica.ts && <repoint clients>` stops when nothing was promoted.
  if (answer?.trim().toLowerCase() !== "yes") {
    info("Promotion cancelled");
    process.exit(1);
  }
}

info(`Promoting '${container}'...`);
const promote =
  await $`docker exec -u postgres ${container} pg_ctl promote ${dataDirArgs}`.nothrow();
if (promote.exitCode !== 0)
  fail(`pg_ctl promote failed (exit ${promote.exitCode}); its message is above`);

success(`'${container}' is now a primary.`);
process.stdout.write(`
Next:
  1. Point applications at '${container}'.
  2. Rebuild the old primary as a replica of it before starting it again (re-clone or pg_rewind).
  3. Replication slots are not copied to replicas: create the slots the new replicas need.
`);
