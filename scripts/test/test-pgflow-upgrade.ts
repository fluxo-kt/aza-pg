#!/usr/bin/env bun
/**
 * pgflow-upgrade on a database a previous release created: the image under test starts on that release's data volume,
 * and `pgflow-upgrade` (no --from) must leave pgflow exactly as a fresh install of the image under test.
 *
 * "Exactly" is a fingerprint of schemas pgflow and pgflow_telemetry: columns with defaults, constraints, indexes,
 * function signatures + bodies + proconfig + SECURITY DEFINER + grants, triggers, enums, table/sequence/schema grants,
 * RLS policies, telemetry table row counts, and pgflow's cron.job rows. Grants are normalised through acldefault()
 * because NULL and the default ACL mean the same.
 *
 * Cases: a migration that fails rolls the whole database back (fingerprint byte-identical, files restored); the real
 * upgrade matches the fresh install; a second run says "up to date".
 *
 * --write-legacy-hashes: for every release that shipped pgflow before the "pgflow X.Y.Z" schema comment, measure the
 * structure hash pgflow-upgrade detects it by, assert the upgrade outcome (0.14.1 upgrades to the fresh fingerprint,
 * 0.13.x is refused unchanged), and rewrite docker/postgres/pgflow/legacy-structure.tsv. Run it after changing
 * structure-hash.sql, then rebuild the image.
 *
 * Usage: bun scripts/test/test-pgflow-upgrade.ts [image] [--write-legacy-hashes]
 *        (image also via --image=TAG or POSTGRES_IMAGE; default: the local build)
 */

import { join } from "node:path";
import { generateUniqueProjectName, waitForPostgres } from "../utils/docker";
import { resolveImageTag } from "./image-resolver";

const IMAGE = resolveImageTag();
const RUN_ID = generateUniqueProjectName("aza-pg-pgflow-upgrade");
const WRITE_LEGACY = Bun.argv.includes("--write-legacy-hashes");
const LEGACY_TABLE = join(import.meta.dir, "../../docker/postgres/pgflow/legacy-structure.tsv");
const UPGRADE_DIR = "/opt/pgflow/upgrade";

interface Release {
  ref: string;
  pgflow: string;
  /** Refused unchanged: 0.13.x images installed an incomplete schema that no migration replay repairs. */
  refused: boolean;
}
// Releases that shipped pgflow before the schema comment existed; digest-pinned and frozen, so this list never grows.
// The last one is the routine case: the newest such release, the one most databases in the field came from.
const LEGACY: Release[] = [
  {
    ref: "ghcr.io/fluxo-kt/aza-pg:18.1-202601171501-single-node@sha256:44a41a4e19c018d5994c9f323a519511a158de55d7a10358195f9d334ba0a9d1",
    pgflow: "0.13.1",
    refused: true,
  },
  {
    ref: "ghcr.io/fluxo-kt/aza-pg:18.1-202601221905-single-node@sha256:89ebabe86f5b510daeb57fa1d16c8bae9c0ca12a1bd51b2be2221c150da494a6",
    pgflow: "0.13.2",
    refused: true,
  },
  {
    ref: "ghcr.io/fluxo-kt/aza-pg:18.1-202602082259-single-node@sha256:477939265883b6e41c455278d3aa1ea5ef5fa534c21da0b764b47a99ae090c3f",
    pgflow: "0.13.3",
    refused: true,
  },
  {
    ref: "ghcr.io/fluxo-kt/aza-pg:18.4-202605172147-single-node@sha256:8c9ca4811e8acd988ec5492b42f287715462dd5364678845c4c2e0a46432af7c",
    pgflow: "0.14.1",
    refused: false,
  },
  {
    ref: "ghcr.io/fluxo-kt/aza-pg:18.4-202606031012-single-node@sha256:0f0ed854fcb290d35e08d51a7f4eb23a8d5b5501f7e4e843d3127afa4d4d8446",
    pgflow: "0.14.1",
    refused: false,
  },
];

const FINGERPRINT_SQL = `
WITH s AS (SELECT oid FROM pg_namespace WHERE nspname IN ('pgflow','pgflow_telemetry'))
SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE c.relnamespace IN (SELECT oid FROM s) AND c.relkind IN ('r','p','v','m') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace IN (SELECT oid FROM s)
UNION ALL SELECT 'index ' || regexp_replace(pg_get_indexdef(indexrelid), 'INDEX \\S+ ON', 'INDEX ON') FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace IN (SELECT oid FROM s)
UNION ALL SELECT 'function ' || p.oid::regprocedure || ' secdef=' || p.prosecdef || ' vol=' || p.provolatile::text || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '') || ' acl=' || coalesce(p.proacl, acldefault('f', p.proowner))::text || ' body=' || md5(regexp_replace(lower(p.prosrc), '\\s+', '', 'g')) FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM s)
UNION ALL SELECT 'trigger ' || tgrelid::regclass || ' ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace IN (SELECT oid FROM s) AND NOT t.tgisinternal
UNION ALL SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace IN (SELECT oid FROM s) GROUP BY t.typname
UNION ALL SELECT 'relacl ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl, acldefault((CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))::text FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM s) AND c.relkind IN ('r','p','v','m','S')
UNION ALL SELECT 'nspacl ' || nspname || ' ' || coalesce(nspacl, acldefault('n', nspowner))::text FROM pg_namespace WHERE oid IN (SELECT oid FROM s)
UNION ALL SELECT 'policy ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname IN ('pgflow','pgflow_telemetry')
UNION ALL SELECT 'rls ' || c.relname || ' ' || c.relrowsecurity FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM s) AND c.relkind = 'r'
UNION ALL SELECT 'cron ' || jobname || ' ' || schedule || ' ' || md5(command) FROM cron.job WHERE jobname LIKE 'pgflow%'
UNION ALL SELECT 'telemetry-rows ' || c.relname || ' ' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgflow_telemetry' AND c.relkind = 'r'
ORDER BY 1
`;

const containers = new Set<string>();
const volumes = new Set<string>();

interface CaseResult {
  name: string;
  passed: boolean;
  ms: number;
}
const results: CaseResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await fn();
    const ms = Math.round(performance.now() - start);
    results.push({ name, passed: true, ms });
    console.log(`✅ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, ms });
    console.log(`❌ ${name} (${ms}ms)\n   ${message.replaceAll("\n", "\n   ")}`);
  }
}

async function docker(
  args: string[],
  stdin?: string
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

async function must(args: string[], stdin?: string): Promise<string> {
  const r = await docker(args, stdin);
  if (r.code !== 0) throw new Error(`docker ${args.join(" ")} exited ${r.code}: ${r.err || r.out}`);
  return r.out;
}

/** Starts `image` (on `volume` when given) and returns once its final server answers. */
async function start(name: string, image: string, volume?: string): Promise<void> {
  containers.add(name);
  const mount = volume ? ["-v", `${volume}:/var/lib/postgresql`] : [];
  await must([
    "run",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=upgrade-${process.pid}`,
    ...mount,
    image,
  ]);
  await waitForPostgres({ container: name, timeout: 180 });
}

async function remove(name: string): Promise<void> {
  // -v: the image declares a PGDATA volume; without it every run would leave an anonymous volume behind.
  await docker(["rm", "-f", "-v", name]);
  containers.delete(name);
}

async function psql(container: string, sql: string): Promise<string> {
  return must(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-f",
      "-",
    ],
    sql
  );
}

async function fingerprint(container: string): Promise<string> {
  const fp = await psql(container, FINGERPRINT_SQL);
  // An empty fingerprint compares equal to another empty one: the instrument would be blind, so it is an error.
  if (!fp.includes("\nfunction "))
    throw new Error(`fingerprint of ${container} has no pgflow functions`);
  return fp;
}

function expectSame(actual: string, expected: string, what: string): void {
  if (actual === expected) return;
  const a = new Set(actual.split("\n"));
  const e = new Set(expected.split("\n"));
  const lines = [
    ...[...e].filter((l) => !a.has(l)).map((l) => `- ${l}`),
    ...[...a].filter((l) => !e.has(l)).map((l) => `+ ${l}`),
  ];
  throw new Error(`${what} (- fresh install, + upgraded):\n${lines.slice(0, 30).join("\n")}`);
}

/**
 * Lets `release` create a database on a new volume, then starts the image under test on that volume.
 * Returns the container name and the structure hash pgflow-upgrade detects the database by.
 */
async function onReleaseVolume(
  release: Release,
  index: number,
  hashSql: string
): Promise<{ container: string; hash: string }> {
  const volume = `${RUN_ID}-vol-${index}`;
  volumes.add(volume);
  await must(["volume", "create", volume]);
  const old = `${RUN_ID}-old-${index}`;
  await start(old, release.ref, volume);
  const hash = (await psql(old, hashSql)).trim();
  await remove(old);
  const container = `${RUN_ID}-new-${index}`;
  await start(container, IMAGE, volume);
  return { container, hash };
}

async function upgrade(container: string): Promise<{ code: number; output: string }> {
  const r = await docker(["exec", container, "pgflow-upgrade"]);
  return { code: r.code, output: (r.out + r.err).trim() };
}

async function routine(fresh: Promise<string>, hashSql: string): Promise<void> {
  const release = LEGACY.at(-1)!;
  const { container } = await onReleaseVolume(release, LEGACY.length - 1, hashSql);
  const before = await fingerprint(container);

  await test("a failing migration rolls the whole database back", async () => {
    const lastMigration = (
      await must(["exec", container, "tail", "-n", "1", `${UPGRADE_DIR}/versions.tsv`])
    )
      .trim()
      .split("\t")[1];
    const file = `${UPGRADE_DIR}/migrations/${lastMigration}`;
    const sum = `find ${UPGRADE_DIR} -type f -exec md5sum {} + | sort`;
    const original = await must(["exec", "-u", "root", container, "sh", "-c", sum]);
    // Earlier migrations of the same run have already applied when this statement fails.
    await must([
      "exec",
      "-u",
      "root",
      container,
      "sh",
      "-c",
      `cp -a ${UPGRADE_DIR} /tmp/upgrade.orig && echo 'SELECT 1/0;' >> ${file}`,
    ]);
    try {
      const r = await upgrade(container);
      if (r.code === 0) throw new Error(`exit 0 with a failing migration:\n${r.output}`);
      expectSame(await fingerprint(container), before, "database changed by a failed upgrade");
    } finally {
      await must([
        "exec",
        "-u",
        "root",
        container,
        "sh",
        "-c",
        `rm -rf ${UPGRADE_DIR} && cp -a /tmp/upgrade.orig ${UPGRADE_DIR}`,
      ]);
    }
    const restored = await must(["exec", "-u", "root", container, "sh", "-c", sum]);
    if (restored !== original) throw new Error(`${UPGRADE_DIR} not restored byte for byte`);
  });

  await test(`pgflow-upgrade without --from brings a ${release.pgflow} database to the fresh install`, async () => {
    const r = await upgrade(container);
    if (r.code !== 0) throw new Error(`exit ${r.code}:\n${r.output}`);
    expectSame(
      await fingerprint(container),
      await fresh,
      "upgraded pgflow differs from a fresh install"
    );
  });

  await test("a second run reports up to date and changes nothing", async () => {
    const after = await fingerprint(container);
    const r = await upgrade(container);
    if (r.code !== 0 || !/up to date/.test(r.output))
      throw new Error(`exit ${r.code}:\n${r.output}`);
    expectSame(await fingerprint(container), after, "second run changed the database");
  });
}

async function writeLegacyHashes(fresh: Promise<string>, hashSql: string): Promise<void> {
  // Indexed by release, not filled in completion order, so a rerun writes the same bytes.
  const hashes: string[] = [];
  await Promise.all(
    LEGACY.map((release, index) =>
      test(`${release.ref.split("@")[0]} (pgflow ${release.pgflow})`, async () => {
        const { container, hash } = await onReleaseVolume(release, index, hashSql);
        hashes[index] = hash;
        const before = await fingerprint(container);
        const r = await upgrade(container);
        if (release.refused) {
          if (r.code === 0)
            throw new Error(`a ${release.pgflow} database was upgraded:\n${r.output}`);
          expectSame(await fingerprint(container), before, "a refused database was changed");
        } else {
          if (r.code !== 0) throw new Error(`exit ${r.code}:\n${r.output}`);
          expectSame(
            await fingerprint(container),
            await fresh,
            "upgraded pgflow differs from a fresh install"
          );
        }
      })
    )
  );
  if (results.some((r) => !r.passed)) return;
  const rows = new Map<string, string>();
  LEGACY.forEach((release, index) => {
    const hash = hashes[index]!;
    const label = release.refused ? "-" : release.pgflow;
    const known = rows.get(hash);
    if (known !== undefined && known !== label) {
      throw new Error(
        `hash ${hash} is both ${known} and ${label}; structure-hash.sql cannot tell them apart`
      );
    }
    rows.set(hash, label);
  });
  const header = (await Bun.file(LEGACY_TABLE).text()).split("\n").filter((l) => l.startsWith("#"));
  const body = [...rows].map(([hash, label]) => `${hash}\t${label}`);
  await Bun.write(LEGACY_TABLE, `${[...header, ...body].join("\n")}\n`);
  console.log(`Wrote ${LEGACY_TABLE}; rebuild the image so pgflow-upgrade reads it.`);
}

async function cleanup(): Promise<void> {
  await Promise.all([...containers].map(remove));
  await Promise.all([...volumes].map((v) => docker(["volume", "rm", "-f", v])));
}

process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
const started = performance.now();
try {
  // The hash query the image under test detects databases with: measuring with any other copy would prove nothing.
  const hashSql = await must([
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    IMAGE,
    "/opt/pgflow/structure-hash.sql",
  ]);
  const fresh = (async () => {
    const name = `${RUN_ID}-fresh`;
    await start(name, IMAGE);
    return fingerprint(name);
  })();
  // A failed fresh start surfaces in the cases that await it; this keeps it from also crashing the process.
  fresh.catch(() => {});
  await (WRITE_LEGACY ? writeLegacyHashes(fresh, hashSql) : routine(fresh, hashSql));
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.passed).length;
console.log(
  `${results.length - failed}/${results.length} passed in ${Math.round((performance.now() - started) / 1000)}s (${IMAGE})`
);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
