#!/usr/bin/env bun
/**
 * Automatic major upgrade: a container started on a volume holding the previous release's cluster must bring it to
 * this image's PostgreSQL major with no operator step, never lose it, and stop where it cannot.
 *
 * The old cluster is made by the real previous release (MANIFEST_METADATA.previousImage), so the upgrade fetches and
 * runs that release's server exactly as in production. Images built with shipMajorUpgrade off lack the upgrade; for
 * those the suite checks the shipped image refuses (stops, data untouched) and runs the upgrade on the variant
 * `bun scripts/nix/build-image.ts --major-upgrade` builds, tagged `<image>-major-upgrade`, so every round proves it.
 * While the previous release has this image's major (pg_upgrade works within one major), its cluster is placed at the
 * path of the major below, which is all the entrypoint uses to tell majors apart.
 *
 * Usage: bun scripts/test-all.ts scripts/test/test-major-upgrade.ts
 */

import { dirname } from "node:path";
import { $ } from "bun";
import { afterAll, expect, test } from "bun:test";
import { MANIFEST_METADATA } from "../extensions/manifest-data";
import { sqlOk } from "../utils/psql";
import {
  TEST_SERVER,
  TEST_SERVER_MEMORY,
  generateUniqueContainerName,
  waitForPostgres,
} from "../utils/docker";
import { staleImageReason } from "../nix/image-inputs";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag({ argv: [] });
const PREVIOUS = MANIFEST_METADATA.previousImage;
const created: string[] = [];
const volume = generateUniqueContainerName("aza-pg-upgrade-vol");
// pgBackRest as an operator configures it, with the repository on the same volume. No pg1-path: the image derives it.
const BACKREST = [
  "PGBACKREST_STANZA=main",
  "PGBACKREST_REPO1_PATH=/var/lib/postgresql/repo",
  "PGBACKREST_ARCHIVE_TIMEOUT=15",
];
const SECRET = "survives-the-upgrade";

afterAll(async () => {
  for (const name of created) await $`docker rm -f -v ${name}`.nothrow().quiet();
  await $`docker volume rm -f ${volume}`.nothrow().quiet();
});

const hasUpgrade = async (image: string) =>
  (
    await $`docker run --rm --entrypoint sh ${image} -c ${"command -v aza-pg-major-upgrade"}`
      .nothrow()
      .quiet()
  ).exitCode === 0;

/** Starts `image` detached on the shared volume. */
async function start(
  image: string,
  env: string[] = [],
  dockerArgs: string[] = []
): Promise<string> {
  const name = generateUniqueContainerName("aza-pg-upgrade");
  created.push(name);
  const envArgs = ["POSTGRES_PASSWORD=upgrade-test", ...env].flatMap((e) => ["-e", e]);
  await $`docker run -d --name ${name} ${TEST_SERVER_MEMORY} -v ${volume}:/var/lib/postgresql ${dockerArgs} ${envArgs} ${image}`.quiet();
  return name;
}

/** Waits for the container to stop and returns its exit code with its log. */
async function stopped(name: string): Promise<{ code: number; log: string }> {
  const code = Number((await $`docker wait ${name}`.quiet().text()).trim());
  const r = await $`docker logs ${name}`.nothrow().quiet();
  return { code, log: r.stdout.toString() + r.stderr.toString() };
}

const pgbackrest = (container: string, command: string) =>
  $`docker exec -u postgres ${container} pgbackrest ${command}`.quiet();

/** psql over TCP, so pg_hba.conf's host rules decide (local socket connections are trusted). */
/** Returns psql's error text, empty on success: a failure must name its cause (refused, no pg_hba entry, password). */
async function tcpLogin(container: string, password: string): Promise<string> {
  const ip = (
    await $`docker inspect -f ${"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"} ${container}`
      .quiet()
      .text()
  ).trim();
  const r =
    await $`docker exec -e PGPASSWORD=${password} ${container} psql -X -h ${ip} -U postgres -tAc ${"SELECT 1"}`
      .nothrow()
      .quiet();
  return r.exitCode === 0 ? "" : r.stderr.toString().trim() || `psql exited ${r.exitCode}`;
}

/** Shell as postgres on the volume, through the image's own tools. */
const onVolume = (script: string) =>
  $`docker run --rm -u postgres -v ${volume}:/var/lib/postgresql --entrypoint bash ${IMAGE} -c ${script}`
    .quiet()
    .text();

test("the previous release's cluster is upgraded at start, refused where it must be, and survives a failure", async () => {
  const major = Number(
    (await $`docker run --rm --entrypoint sh ${IMAGE} -c ${"echo $PG_MAJOR"}`.quiet().text()).trim()
  );
  // The flag decides which image carries the upgrade, never what IMAGE happens to contain: a tag re-pointed at the
  // variant once made every suite test it as the release, while this suite silently skipped the shipped refusal.
  const shipsUpgrade = MANIFEST_METADATA.shipMajorUpgrade;
  if ((await hasUpgrade(IMAGE)) !== shipsUpgrade)
    throw new Error(
      `${IMAGE} ${shipsUpgrade ? "lacks" : "carries"} the upgrade although shipMajorUpgrade is ${shipsUpgrade}: it is not the release image; rebuild it with bun run build`
    );
  const upgradeImage = shipsUpgrade ? IMAGE : `${IMAGE}-major-upgrade`;
  if (!(await hasUpgrade(upgradeImage)))
    throw new Error(
      `${upgradeImage} is missing or lacks the upgrade: bun scripts/nix/build-image.ts --major-upgrade --tag ${upgradeImage}`
    );
  // test-all checks only the image it was given; a variant built from older sources would test old code.
  const stale = await staleImageReason(upgradeImage);
  if (stale) throw new Error(stale);
  const oldMajor = Number(
    (
      await $`docker run --rm --entrypoint sh ${PREVIOUS} -c ${"echo $PG_MAJOR"}`.quiet().text()
    ).trim()
  );
  const oldData = `/var/lib/postgresql/${oldMajor === major ? major - 1 : oldMajor}/docker`;
  const newData = `/var/lib/postgresql/${major}/docker`;

  // A cluster of a major this image cannot upgrade from stops at once, naming the major it needs; left in place, it is
  // the older decoy the upgrade below must pass over for the newest cluster.
  await onVolume(
    "mkdir -p /var/lib/postgresql/16/docker && echo 16 > /var/lib/postgresql/16/docker/PG_VERSION"
  );
  const unsupported = await stopped(await start(upgradeImage));
  expect(unsupported.code).toBe(1);
  expect(unsupported.log).toContain(`upgrades only from PostgreSQL ${oldMajor}`);

  // The previous release makes the cluster; regproc is a type pg_upgrade refuses in user tables (a real failure).
  // The previous release has no PGBACKREST_PG1_PATH of its own, so its containers get the one an operator would write.
  const oldEnv = [`PGDATA=${oldData}`, `PGBACKREST_PG1_PATH=${oldData}`, ...BACKREST];
  const old = await start(PREVIOUS, oldEnv);
  await waitForPostgres({ container: old, timeout: 120 });
  await sqlOk(old, [
    "CREATE TABLE kept (v int)",
    "INSERT INTO kept VALUES (42)",
    "CREATE TABLE blocks (p regproc)",
    // TimescaleDB keeps chunk catalogs and compressed data in its own tables, with libraries named by version: the
    // extension most likely to break across pg_upgrade.
    "CREATE TABLE metrics (t timestamptz NOT NULL, v int)",
    "SELECT create_hypertable('metrics', 't', chunk_time_interval => interval '1 day')",
    "INSERT INTO metrics SELECT '2026-01-01'::timestamptz + i * interval '1 hour', i FROM generate_series(1, 100) i",
    "ALTER TABLE metrics SET (timescaledb.compress)",
    "SELECT count(compress_chunk(c)) FROM show_chunks('metrics') c",
    // Operator state outside relation data, each lost by a bare pg_upgrade: ALTER SYSTEM's file, and pgsodium's root key.
    "ALTER SYSTEM SET log_min_duration_statement = 4321",
    "ALTER SYSTEM SET archive_mode = on",
    "ALTER SYSTEM SET archive_command = 'pgbackrest archive-push %p'",
    `SELECT vault.create_secret('${SECRET}')`,
  ]);
  // No restart for archive_mode: stanza-create needs no archiving, and the upgraded server reads it from the carried file.
  await $`docker exec -u postgres ${old} mkdir -p /var/lib/postgresql/repo`.quiet();
  await pgbackrest(old, "stanza-create");
  await $`docker stop ${old}`.quiet();

  if (upgradeImage !== IMAGE) {
    const shipped = await stopped(await start(IMAGE));
    expect(shipped.code).toBe(1);
    expect(shipped.log).toContain("this image does not upgrade from that major");
  }

  await onVolume(`touch ${oldData}/standby.signal`);
  const standby = await stopped(await start(upgradeImage));
  expect(standby.code).toBe(1);
  expect(standby.log).toContain("a standby is not upgraded");
  await onVolume(`rm ${oldData}/standby.signal`);

  // Offline: the stop must come before anything touches the data and print the command that fills the old server from
  // the previous image; running exactly that command (volume substituted) must make every later start work offline.
  const offline = await stopped(await start(upgradeImage, [], ["--network", "none"]));
  expect(offline.code).toBe(1);
  const fill = offline.log.split("\n").find((l) => l.trim().startsWith("docker run"));
  if (!fill) throw new Error(`no copy command in the offline stop:\n${offline.log}`);
  expect(await onVolume(`ls -A ${newData}`)).toBe("");
  await $`sh -c ${fill.replace("<your data volume>", volume)}`.quiet();

  const failed = await stopped(await start(upgradeImage, [], ["--network", "none"]));
  expect(failed.code).toBe(1);
  expect(failed.log).toContain("upgrade failed");
  // pg_upgrade's report file, which the cleanup deletes, is printed first and names the cause (the regproc table); the
  // "--- <file>:" header comes only from that printing, so a log merely mentioning the table cannot pass.
  expect(failed.log).toMatch(/^--- \S+\.txt:\n(?:.*\n)*?.*\bblocks\b/m);
  // Rollback: the previous release starts on the old cluster again, data intact, and PGDATA holds no half cluster.
  expect(await onVolume(`ls -A ${newData}`)).toBe("");
  const restored = await start(PREVIOUS, oldEnv);
  await waitForPostgres({ container: restored, timeout: 120 });
  expect(await sqlOk(restored, "SELECT v FROM kept")).toBe("42");
  await sqlOk(restored, "DROP TABLE blocks");
  await $`docker stop ${restored}`.quiet();

  // A failure after --link linked the files: pg_upgrade has renamed the old pg_control, and the old cluster starts again
  // only if restore_old renames it back. tmpfs cannot reflink, so the mode ladder must take --link there. The wrapper
  // lets the real pg_upgrade finish every step (the most linking any failure can leave) and only then fails; the old
  // server, already fetched into the volume's store, must then open the old cluster and read its row.
  const linked = (
    await $`docker run --rm -u postgres ${TEST_SERVER} -v ${volume}:/src:ro --entrypoint bash ${upgradeImage} -c ${`
      cp -a /src/.aza-old-store /var/lib/postgresql/ && mkdir -p ${dirname(oldData)} && cp -a /src${oldData.slice("/var/lib/postgresql".length)} ${oldData}
      mkdir /tmp/shim && printf '#!/bin/bash\\n"%s" "$@" || exit\\nexit 1\\n' "$(command -v pg_upgrade)" > /tmp/shim/pg_upgrade && chmod +x /tmp/shim/pg_upgrade
      spl=$(sed -n 's/^readonly DEFAULT_SHARED_PRELOAD_LIBRARIES="\\(.*\\)"$/\\1/p' /usr/local/bin/docker-auto-config-entrypoint.sh)
      PATH=/tmp/shim:$PATH SHARED_PRELOAD_LIBRARIES=$spl PGSODIUM_GETKEY_PATH=/usr/share/postgresql/$PG_MAJOR/extension/pgsodium_getkey \\
        aza-pg-major-upgrade ${oldData} ${newData} 2>&1
      echo "upgrade-exit=$? new-entries=$(ls -A ${newData} | wc -l) control=$(ls ${oldData}/global | grep pg_control | paste -sd, -)"
      touch /tmp/empty.conf
      echo "SELECT v FROM kept" | /nix/store/$(sed -n 2p /usr/local/share/aza-pg/previous-layers)/bin/postgres --single \\
        -c config_file=/tmp/empty.conf -c hba_file=/tmp/empty.conf -c ident_file=/tmp/empty.conf -D ${oldData} postgres 2>&1
    `}`
      .nothrow()
      .quiet()
  ).stdout.toString();
  expect(linked).toContain("(pg_upgrade --link)");
  expect(linked).toContain("upgrade-exit=1 new-entries=0 control=pg_control\n");
  expect(linked).toContain('v = "42"');

  // POSTGRES_BIND_IP as the stacks set it, so a TCP login reaches the carried pg_hba.conf's scram rule.
  const upgraded = await start(upgradeImage, [...BACKREST, "POSTGRES_BIND_IP=0.0.0.0"]);
  await waitForPostgres({ container: upgraded, timeout: 180 });
  expect(await sqlOk(upgraded, "SELECT v FROM kept")).toBe("42");
  expect(await sqlOk(upgraded, "SHOW server_version_num")).toStartWith(String(major));
  expect(await sqlOk(upgraded, "SELECT sum(v) FROM metrics")).toBe("5050");
  expect(
    await sqlOk(
      upgraded,
      "SELECT bool_and(is_compressed) FROM timescaledb_information.chunks WHERE hypertable_name = 'metrics'"
    )
  ).toBe("t");
  expect(await sqlOk(upgraded, `SELECT decrypted_secret FROM vault.decrypted_secrets`)).toBe(
    SECRET
  );
  expect(await sqlOk(upgraded, "SHOW log_min_duration_statement")).toBe("4321ms");
  expect(await tcpLogin(upgraded, "upgrade-test")).toBe("");
  expect(await tcpLogin(upgraded, "wrong-password")).toContain("password authentication failed");
  // check switches WAL and waits for the archive: the stanza was upgraded and archive_command works on the new major.
  // The first-start migration's verdict; the whole log on failure names which step skipped or failed.
  const upgradedLog = (await $`docker logs ${upgraded}`.quiet()).stderr.toString();
  if (!upgradedLog.includes("pgBackRest stanza 'main'"))
    throw new Error(`no stanza-upgrade verdict in the upgraded container's log:\n${upgradedLog}`);
  await pgbackrest(upgraded, "check");
  // The fetched old server is gone; the marker names this image's server, so the next start migrates nothing.
  const state = await onVolume(`ls -A /var/lib/postgresql; cat ${newData}/aza-pg-image`);
  expect(state).not.toContain(".aza-old-store");
  const server =
    await $`docker run --rm --entrypoint sh ${upgradeImage} -c ${'readlink -f "$(command -v postgres)"'}`
      .quiet()
      .text();
  expect(state.trim().split("\n").at(-1)).toBe(server.trim());

  // A cluster of a newer major (the next release, after a rollback from it) is never this image's upgrade source: its
  // pg_control is the freshest, so a selection by recency or by PG_VERSION would name it below.
  const newer = "/var/lib/postgresql/99/docker";
  await $`docker stop ${upgraded}`.quiet();
  // Rollback: the previous release runs on the kept cluster, as an operator returning to it would; this image must then
  // refuse to serve the copy taken at the upgrade. With --link the kept cluster is unusable by design, so no rollback.
  if (upgradedLog.includes("(--link)")) {
    console.log(
      "pg_upgrade --link: the kept cluster is no rollback, so the rollback guard is not exercised"
    );
  } else {
    const back = await start(PREVIOUS, oldEnv);
    await waitForPostgres({ container: back, timeout: 120 });
    await $`docker stop ${back}`.quiet();
    await onVolume(
      `mkdir -p ${newer}/global && echo 99 > ${newer}/PG_VERSION && touch ${newer}/global/pg_control`
    );
    const refused = await stopped(await start(upgradeImage));
    expect(refused.code).toBe(1);
    expect(refused.log).toContain(`cluster ${oldData} beside ${newData}: it ran after`);
  }
  // With PGDATA empty, a newer cluster holds the newest data: neither the older cluster is upgraded nor initdb runs.
  await onVolume(`mkdir -p ${newer} && echo 99 > ${newer}/PG_VERSION && rm -rf ${newData}`);
  const hidden = await stopped(await start(upgradeImage));
  expect(hidden.code).toBe(1);
  expect(hidden.log).toContain(
    `cluster ${newer} beside ${newData}: it is newer than this PostgreSQL`
  );
}, 280_000);
