#!/usr/bin/env bun
/**
 * Fetch the latest stable tag (non pre-release) for a list of GitHub repositories
 * and print as JSON. Designed to help curate docker/postgres/extensions.manifest.json.
 *
 * Usage: bun scripts/extensions/fetch-latest.ts
 */

import { spawn } from "bun";

type RepoSpec = {
  name: string;
  repo: string;
  include?: RegExp[];
  exclude?: RegExp[];
  transform?: (tag: string) => string;
};

const repos: RepoSpec[] = [
  { name: "hypopg", repo: "https://github.com/HypoPG/hypopg.git" },
  { name: "index_advisor", repo: "https://github.com/supabase/index_advisor.git" },
  { name: "plpgsql_check", repo: "https://github.com/okbob/plpgsql_check.git" },
  { name: "pg_safeupdate", repo: "https://github.com/eradman/pg-safeupdate.git" },
  { name: "pgaudit", repo: "https://github.com/pgaudit/pgaudit.git" },
  { name: "supautils", repo: "https://github.com/supabase/supautils.git" },
  { name: "pg_cron", repo: "https://github.com/citusdata/pg_cron.git" },
  { name: "pg_net", repo: "https://github.com/supabase/pg_net.git" },
  { name: "pgsql-http", repo: "https://github.com/pramsey/pgsql-http.git" },
  { name: "supabase-wrappers", repo: "https://github.com/supabase/wrappers.git" },
  { name: "pgroonga", repo: "https://github.com/pgroonga/pgroonga.git" },
  { name: "rum", repo: "https://github.com/postgrespro/rum.git" },
  { name: "postgis", repo: "https://github.com/postgis/postgis.git" },
  { name: "pgrouting", repo: "https://github.com/pgRouting/pgrouting.git" },
  { name: "pgsodium", repo: "https://github.com/michelp/pgsodium.git" },
  { name: "vault", repo: "https://github.com/supabase/vault.git" },
  { name: "pg_jsonschema", repo: "https://github.com/supabase/pg_jsonschema.git" },
  { name: "pg_hashids", repo: "https://github.com/iCyberon/pg_hashids.git" },
  { name: "pgmq", repo: "https://github.com/tembo-io/pgmq.git" },
  {
    name: "pg_repack",
    repo: "https://github.com/reorg/pg_repack.git",
    include: [/^ver_\d+\.\d+\.\d+$/i],
    transform: (tag) => tag.replace(/^ver_/i, ""),
  },
  { name: "pg_stat_monitor", repo: "https://github.com/percona/pg_stat_monitor.git" },
  { name: "pg_plan_filter", repo: "https://github.com/pgexperts/pg_plan_filter.git" },
  { name: "pgvector", repo: "https://github.com/pgvector/pgvector.git" },
  {
    name: "timescaledb",
    repo: "https://github.com/timescale/timescaledb.git",
    include: [/^\d+\.\d+\.\d+$/],
  },
  {
    name: "timescaledb_toolkit",
    repo: "https://github.com/timescale/timescaledb-toolkit.git",
    include: [/^\d+\.\d+\.\d+$/],
  },
  {
    name: "wal2json",
    repo: "https://github.com/eulerto/wal2json.git",
    include: [/^wal2json_\d+_\d+$/],
    transform: (tag) => tag.replace(/^wal2json_/, "").replace("_", "."),
  },
  { name: "pg_partman", repo: "https://github.com/pgpartman/pg_partman.git" },
  { name: "pgvectorscale", repo: "https://github.com/timescale/pgvectorscale.git" },
  { name: "citus", repo: "https://github.com/citusdata/citus.git" },
  { name: "postgresql-hll", repo: "https://github.com/citusdata/postgresql-hll.git" },
  {
    name: "pgbackrest",
    repo: "https://github.com/pgbackrest/pgbackrest.git",
    include: [/^release\/\d+\.\d+\.\d+$/],
    transform: (tag) => tag.replace(/^release\//, ""),
  },
  { name: "pgbadger", repo: "https://github.com/darold/pgbadger.git" },
  {
    name: "pgaudit_set_user",
    repo: "https://github.com/pgaudit/set_user.git",
    include: [/^REL\d+_\d+_\d+$/],
    transform: (tag) => tag.replace(/^REL/, "").replaceAll("_", "."),
  },
];

const preReleasePatterns = [/alpha/i, /beta/i, /rc/i, /preview/i];

type ResultRow = {
  name: string;
  repo: string;
  tag: string;
  version: string;
  commit: string;
};

function parseVersionParts(tag: string): (number | string)[] {
  const normalized = tag.replace(/^v/, "");
  return normalized
    .split(/[\.-_]/)
    .map((part) => (Number.isFinite(Number(part)) ? Number(part) : part));
}

function isGreaterTag(a: string, b: string): boolean {
  if (a === b) return false;
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;
    if (aPart === bPart) continue;
    const aIsNum = typeof aPart === "number";
    const bIsNum = typeof bPart === "number";
    if (aIsNum && bIsNum) {
      return (aPart as number) > (bPart as number);
    }
    if (aIsNum !== bIsNum) {
      return aIsNum;
    }
    return String(aPart) > String(bPart);
  }
  return aParts.length > bParts.length;
}

async function lsRemote(spec: RepoSpec): Promise<Omit<ResultRow, "name" | "version">[]> {
  const proc = spawn(["git", "ls-remote", "--tags", spec.repo], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ls-remote failed for ${repo}: ${stderr}`);
  }
  const rows: Omit<ResultRow, "name" | "version">[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const [commit, ref] = line.split("\t");
    const cleanedRef = ref.replace(/\^\{\}$/, "");
    const tagName = cleanedRef.replace("refs/tags/", "");
    if (tagName.includes("/")) {
      const allowed = spec.include?.some((re) => re.test(tagName));
      if (!allowed) continue;
    }
    if (spec.include && !spec.include.some((re) => re.test(tagName))) {
      continue;
    }
    if (spec.exclude && spec.exclude.some((re) => re.test(tagName))) {
      continue;
    }
    if (preReleasePatterns.some((pattern) => pattern.test(tagName))) {
      continue;
    }
    rows.push({ repo: spec.repo, tag: tagName, commit });
  }
  return rows;
}

async function main() {
  const results: ResultRow[] = [];
  for (const spec of repos) {
    const rows = await lsRemote(spec);
    if (!rows.length) {
      console.error(`warn: ${spec.name} has no stable tags`);
      continue;
    }
    let latest = rows[0];
    for (const candidate of rows) {
      if (isGreaterTag(candidate.tag, latest.tag)) {
        latest = candidate;
      }
    }
    const version = spec.transform ? spec.transform(latest.tag) : latest.tag.replace(/^v/, "");
    results.push({ ...latest, name: spec.name, version });
  }
  console.log(JSON.stringify(results, null, 2));
}

await main();
