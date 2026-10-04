#!/usr/bin/env bun
/**
 * pgflow Schema Generator
 *
 * Fetches and combines all pgflow schema files at the manifest's pgflow tag into
 * tests/fixtures/pgflow/schema.sql, which the image installs at initdb and the tests install directly.
 * The version comes from manifest-data.ts (see ./version.ts), so bumping pgflow is: edit the tag, run this.
 *
 * Usage:
 *   bun scripts/pgflow/generate-schema.ts [--dry-run] [--verbose]
 */

import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format as formatSql } from "sql-formatter";
import { PGFLOW_TAG, PGFLOW_VERSION } from "./version";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const FIXTURES_DIR = join(ROOT_DIR, "tests/fixtures/pgflow");
const UPGRADE_DIR = join(FIXTURES_DIR, "upgrade");
// The first pgflow release an aza-pg image shipped; pgflow-upgrade can start from it or any later release.
const OLDEST_SHIPPED = "0.13.1";
const SQL_FORMATTER_CONFIG = join(ROOT_DIR, ".sql-formatter.json");
// Upstream ships the same pgflow twice: declarative schema files (fresh installs) and incremental migrations (upgrades).
const SCHEMAS_DIR = "pkgs/core/schemas";
const MIGRATIONS_DIR = "pkgs/core/supabase/migrations";

interface GitHubContentItem {
  name: string;
  type: string;
}

async function getGitHubToken(): Promise<string | undefined> {
  const envToken = Bun.env.GITHUB_TOKEN ?? Bun.env.GH_TOKEN;
  if (envToken) {
    return envToken;
  }

  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const token = stdout.trim();
    return exitCode === 0 && token ? token : undefined;
  } catch {
    return undefined;
  }
}

async function loadSqlFormatterConfig(): Promise<Record<string, unknown>> {
  try {
    const configFile = Bun.file(SQL_FORMATTER_CONFIG);
    return await configFile.json();
  } catch {
    // Fallback to sensible defaults matching project conventions
    return {
      language: "postgresql",
      tabWidth: 2,
      useTabs: false,
      keywordCase: "upper",
    };
  }
}

function isGitHubContentItem(value: unknown): value is GitHubContentItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "type" in value &&
    typeof value.name === "string" &&
    typeof value.type === "string"
  );
}

interface Options {
  version: string;
  tag: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--dry-run" && a !== "--verbose");
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}`);
    console.error(
      "The pgflow version comes from the pgflow tag in scripts/extensions/manifest-data.ts."
    );
    console.error("Usage: bun scripts/pgflow/generate-schema.ts [--dry-run] [--verbose]");
    process.exit(1);
  }

  return {
    version: PGFLOW_VERSION,
    tag: PGFLOW_TAG,
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };
}

function upstreamFileUrl(tag: string, dir: string, filename: string): string {
  return `https://raw.githubusercontent.com/pgflow-dev/pgflow/${encodeURIComponent(tag)}/${dir}/${filename}`;
}

const CLEANUP_ENSURE_WORKERS_LOGS_COMPAT_SQL = `-- Cleanup Ensure Workers Logs
-- Cleans up old cron job run details to prevent the table from growing indefinitely.
-- Note: net._http_response is automatically cleaned by pg_net (6 hour TTL), so we only clean cron logs.
CREATE OR REPLACE FUNCTION pgflow.cleanup_ensure_workers_logs (retention_hours INTEGER DEFAULT 24) returns TABLE (cron_deleted BIGINT) language plpgsql security definer
SET
  search_path = pgflow,
  pg_temp AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  IF to_regclass('cron.job_run_details') IS NULL THEN
    RETURN QUERY SELECT 0::BIGINT;
    RETURN;
  END IF;

  EXECUTE 'DELETE FROM cron.job_run_details WHERE end_time < now() - make_interval(hours => $1)'
  USING retention_hours;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN QUERY SELECT deleted_count;
END;
$$;


COMMENT ON function pgflow.cleanup_ensure_workers_logs (INTEGER) IS 'Cleans up old cron job run details to prevent table growth.
Default retention is 24 hours. HTTP response logs (net._http_response) are
automatically cleaned by pg_net with a 6-hour TTL, so they are not cleaned here.
Returns 0 when pg_cron is configured in another database and cron.job_run_details
is absent from the current database.
This function follows the standard pg_cron maintenance pattern recommended by
AWS RDS, Neon, and Supabase documentation.';`;

const VAULT_SECRET_COMPAT_SQL = `-- AZA PostgreSQL Vault Secret Compatibility
-- Reads Supabase Vault secrets without binding pgflow schema installation to vault.decrypted_secrets.
CREATE OR REPLACE FUNCTION pgflow.aza_vault_secret (secret_name TEXT) returns TEXT language plpgsql stable
SET
  search_path = '' AS $$
DECLARE
  secret_value TEXT;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE $query$
    SELECT nullif(decrypted_secret, '')
    FROM vault.decrypted_secrets
    WHERE name = $1
    LIMIT 1
  $query$
  INTO secret_value
  USING secret_name;

  RETURN secret_value;
END;
$$;


COMMENT ON function pgflow.aza_vault_secret (TEXT) IS 'Reads a Supabase Vault secret when vault.decrypted_secrets exists; returns NULL when Vault is not installed in this database.';`;

function replaceRequired(
  filename: string,
  content: string,
  search: string,
  replacement: string
): string {
  if (!content.includes(search)) {
    throw new Error(`Local pgflow schema patch no longer matches upstream ${filename}`);
  }

  return content.replace(search, replacement);
}

function patchCronSearchPath(filename: string, content: string): string {
  return replaceRequired(
    filename,
    content,
    "set search_path = pgflow, cron, pg_temp",
    "set search_path = pgflow, pg_temp"
  );
}

function patchEnsureWorkersCronSetup(filename: string, upstreamContent: string): string {
  let patched = patchCronSearchPath(filename, upstreamContent);
  patched = replaceRequired(
    filename,
    patched,
    "begin\n  -- Remove existing jobs if they exist (ignore errors if not found)",
    "begin\n  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN\n    RETURN 'pg_cron is not available in this database; skipped pgflow worker cron setup';\n  END IF;\n\n  -- Remove existing jobs if they exist (ignore errors if not found)"
  );
  return replaceRequired(
    filename,
    patched,
    "Replaces existing jobs if they exist (idempotent).\nReturns a confirmation message with job IDs.';",
    "Replaces existing jobs if they exist (idempotent).\nReturns a skipped message when pg_cron is configured in another database.\nReturns a confirmation message with job IDs.';"
  );
}

function patchRequeueCronSetup(filename: string, upstreamContent: string): string {
  let patched = patchCronSearchPath(filename, upstreamContent);
  patched = replaceRequired(
    filename,
    patched,
    "begin\n  -- Remove existing job if any",
    "begin\n  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN\n    RETURN 'pg_cron is not available in this database; skipped pgflow stalled-task cron setup';\n  END IF;\n\n  -- Remove existing job if any"
  );
  patched = replaceRequired(filename, patched, "job_id=%s)', \n", "job_id=%s)',\n");
  return replaceRequired(
    filename,
    patched,
    "Replaces existing job if it exists (idempotent).\nReturns a confirmation message with job ID.';",
    "Replaces existing job if it exists (idempotent).\nReturns a skipped message when pg_cron is configured in another database.\nReturns a confirmation message with job ID.';"
  );
}

function patchEnsureWorkersVaultAccess(filename: string, upstreamContent: string): string {
  let patched = replaceRequired(
    filename,
    upstreamContent,
    "nullif((select decrypted_secret from vault.decrypted_secrets where name = 'pgflow_auth_secret'), ''),\n            nullif((select decrypted_secret from vault.decrypted_secrets where name = 'supabase_service_role_key'), '')",
    "pgflow.aza_vault_secret('pgflow_auth_secret'),\n            pgflow.aza_vault_secret('supabase_service_role_key')"
  );
  patched = replaceRequired(
    filename,
    patched,
    "else (select 'https://' || nullif(decrypted_secret, '') || '.supabase.co/functions/v1' from vault.decrypted_secrets where name = 'supabase_project_id')",
    "else 'https://' || pgflow.aza_vault_secret('supabase_project_id') || '.supabase.co/functions/v1'"
  );

  return `${VAULT_SECRET_COMPAT_SQL}\n\n\n${patched}`;
}

// Upstream creates supabase_vault and pg_cron unconditionally, so the shipped schema.sql failed in any database where
// either cannot exist: supabase_vault is optional in aza-pg (ensure_workers reads it through aza_vault_secret), and
// pg_cron can only be created in the database named by cron.database_name (pgflow's cron setup functions report
// "skipped" elsewhere). Guarding them here lets initdb, new databases (docs/PGFLOW.md) and tests run the file as is.
const OPTIONAL_EXTENSIONS_SQL = `DO $extensions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'supabase_vault') THEN
    CREATE EXTENSION IF NOT EXISTS supabase_vault;
  END IF;
  IF current_database() = current_setting('cron.database_name', true) THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  END IF;
END
$extensions$;`;

function patchOptionalExtensions(filename: string, upstreamContent: string): string {
  const patched = replaceRequired(
    filename,
    upstreamContent,
    "create extension if not exists supabase_vault;",
    "-- supabase_vault: created below only where available (aza-pg)"
  );
  return replaceRequired(
    filename,
    patched,
    "create extension if not exists pg_cron;",
    OPTIONAL_EXTENSIONS_SQL
  );
}

function localSchemaContent(filename: string, upstreamContent: string): string {
  if (filename === "0010_extensions.sql") {
    return patchOptionalExtensions(filename, upstreamContent);
  }
  if (filename === "0059_function_ensure_workers.sql") {
    return patchEnsureWorkersVaultAccess(filename, upstreamContent);
  }
  if (filename === "0060_function_cleanup_ensure_workers_logs.sql") {
    return CLEANUP_ENSURE_WORKERS_LOGS_COMPAT_SQL;
  }
  if (filename === "0061_function_setup_ensure_workers_cron.sql") {
    return patchEnsureWorkersCronSetup(filename, upstreamContent);
  }
  if (filename === "0063_function_setup_requeue_stalled_tasks_cron.sql") {
    return patchRequeueCronSetup(filename, upstreamContent);
  }

  return upstreamContent;
}

// Upstream's telemetry migration schedules a daily usage report to telemetry.pgflow.dev at install time. Art's
// ruling: aza-pg never sends pgflow telemetry unless the operator enables it (pgflow_telemetry.enable()). The
// declarative schema used for fresh installs never schedules it, so the upgrade path drops the statement too; it
// would also fail in any pgflow database without pg_cron.
const TELEMETRY_SCHEDULE_SQL = `insert into pgflow_telemetry.job_registry (jobname, jobid)
select 'pgflow_telemetry_report', cron.schedule(
  'pgflow_telemetry_report',
  '17 3 * * *',
  $cron$begin; set local statement_timeout = '5 s'; select pgflow_telemetry.report(); commit;$cron$
);`;

// The 0.13.2 migration schedules the stalled-task job through upstream's setup function, which fails in a pgflow
// database without pg_cron. aza-overrides.sql (patched 0063) re-creates that function in its pg_cron-safe form and
// makes the same call after the migrations, exactly as a fresh install does, so the migration's own call is dropped.
const REQUEUE_SETUP_CALL_SQL =
  "-- Automatically set up the cron job\nSELECT pgflow.setup_requeue_stalled_tasks_cron();";

function localMigrationContent(filename: string, content: string): string {
  if (filename.endsWith("_pgflow_requeue_stalled_tasks.sql")) {
    return replaceRequired(
      filename,
      content,
      REQUEUE_SETUP_CALL_SQL,
      "-- aza-pg: scheduled by aza-overrides.sql after the migrations (pg_cron-safe setup function)"
    );
  }
  if (!filename.endsWith("_pgflow_telemetry.sql")) {
    return content;
  }
  return replaceRequired(
    filename,
    content,
    TELEMETRY_SCHEDULE_SQL,
    "-- aza-pg: telemetry stays unscheduled until the operator runs SELECT pgflow_telemetry.enable();"
  );
}

// Schema files that pgflow-upgrade re-applies after the migrations, because aza-pg's version of their functions
// differs from what the migrations create: every file the generator patches, plus 0030_utilities.sql, whose
// is_local() images up to pgflow 0.14.1 replaced with an always-true version (the migrations never redefine it).
const RESTORED_UPSTREAM_FILES = ["0030_utilities.sql"];

function overrideFiles(schemas: ReadonlyMap<string, string>): string[] {
  return [...schemas.keys()].filter(
    (f) =>
      RESTORED_UPSTREAM_FILES.includes(f) ||
      localSchemaContent(f, schemas.get(f) ?? "") !== schemas.get(f)
  );
}

function stripTrailingWhitespace(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

async function listUpstreamSql(tag: string, dir: string): Promise<string[]> {
  const url = `https://api.github.com/repos/pgflow-dev/pgflow/contents/${dir}?ref=${encodeURIComponent(tag)}`;
  const token = await getGitHubToken();
  const response = await fetch(url, {
    headers: {
      "User-Agent": "aza-pg-schema-generator",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const authHint = token
      ? ""
      : " Set GITHUB_TOKEN/GH_TOKEN or authenticate gh to avoid API limits.";
    throw new Error(
      `Failed to list ${dir} at ${tag}: ${response.status} ${response.statusText}.${authHint}`
    );
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(isGitHubContentItem)) {
    throw new Error("Unexpected GitHub schema directory response");
  }

  return payload
    .filter((item) => item.type === "file" && item.name.endsWith(".sql"))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b));
}

async function fetchUpstreamFile(
  tag: string,
  dir: string,
  filename: string,
  verbose: boolean
): Promise<string> {
  const url = upstreamFileUrl(tag, dir, filename);

  if (verbose) {
    console.log(`  Fetching: ${filename}`);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${filename}: ${response.status} ${response.statusText}\n  URL: ${url}`
    );
  }

  const content = await response.text();

  // Validate that we got actual SQL content, not an error page
  if (content.includes("<!DOCTYPE html>") || content.includes("<html")) {
    throw new Error(`Received HTML instead of SQL for ${filename} - tag may not exist`);
  }

  return content;
}

async function fetchAll(
  tag: string,
  dir: string,
  files: readonly string[],
  verbose: boolean
): Promise<Map<string, string>> {
  console.log(`Fetching ${files.length} files from ${tag}/${dir}...`);
  return new Map(
    await Promise.all(
      files.map(async (f) => [f, await fetchUpstreamFile(tag, dir, f, verbose)] as const)
    )
  );
}

function generateCombinedSchema(
  version: string,
  schemaFiles: readonly string[],
  schemas: Map<string, string>
): string {
  const header = `-- pgflow v${version} Schema
-- Source: https://github.com/pgflow-dev/pgflow/tree/pgflow@${version}/pkgs/core/schemas/
-- Generated by: bun scripts/pgflow/generate-schema.ts
-- Combined from ${schemas.size} individual schema files
`;

  const sections: string[] = [header];

  for (const filename of schemaFiles) {
    const content = schemas.get(filename);
    if (!content) {
      throw new Error(`Missing content for ${filename}`);
    }

    sections.push(`-- ============================================================================
-- Source: ${filename}
-- ============================================================================
${localSchemaContent(filename, content).trim()}

`);
  }

  // Every fresh install records its version on the schema; pgflow-upgrade reads it as the starting point, so an
  // operator upgrading a database created by this image never has to remember which pgflow it shipped.
  sections.push(`-- ============================================================================
-- aza-pg: installed pgflow version
-- ============================================================================
COMMENT ON SCHEMA pgflow IS 'pgflow ${version}';
`);

  return sections.join("\n");
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function listPgflowReleases(): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "git",
      "ls-remote",
      "--tags",
      "https://github.com/pgflow-dev/pgflow.git",
      "refs/tags/pgflow@*",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ls-remote pgflow tags failed: ${stderr}`);
  return [
    ...new Set(
      stdout
        .split("\n")
        .map((line) => line.split("refs/tags/pgflow@")[1]?.replace("^{}", ""))
        .filter((v): v is string => v !== undefined && /^\d+\.\d+\.\d+$/.test(v))
    ),
  ].sort(compareVersions);
}

/**
 * Writes what /usr/local/bin/pgflow-upgrade needs to bring a database created by an older image to this version:
 * upstream's incremental migrations, the last migration of every release since OLDEST_SHIPPED (the starting point
 * for each), and aza-overrides.sql (aza-pg's versions of functions the migrations would otherwise leave different
 * from a fresh install).
 */
async function writeUpgradeFixtures(
  options: Options,
  schemas: ReadonlyMap<string, string>,
  sqlConfig: Record<string, unknown>
): Promise<void> {
  const migrationFiles = await listUpstreamSql(options.tag, MIGRATIONS_DIR);
  const migrations = await fetchAll(options.tag, MIGRATIONS_DIR, migrationFiles, options.verbose);

  const releases = (await listPgflowReleases()).filter(
    (v) => compareVersions(v, OLDEST_SHIPPED) >= 0 && compareVersions(v, options.version) <= 0
  );
  const lastMigrations = await Promise.all(
    releases.map(async (v) => {
      const last = (await listUpstreamSql(`pgflow@${v}`, MIGRATIONS_DIR)).at(-1);
      if (!last) throw new Error(`pgflow@${v} has no migrations`);
      return `${v}\t${last}`;
    })
  );
  if (!releases.includes(options.version)) {
    throw new Error(`pgflow@${options.version} is not among upstream release tags`);
  }

  const overrides = overrideFiles(schemas)
    .map((f) => `-- Source: ${f}\n${localSchemaContent(f, schemas.get(f) ?? "").trim()}\n`)
    .join("\n");

  await rm(UPGRADE_DIR, { recursive: true, force: true });
  await mkdir(join(UPGRADE_DIR, "migrations"), { recursive: true });
  await Promise.all([
    ...migrationFiles.map((f) =>
      Bun.write(
        join(UPGRADE_DIR, "migrations", f),
        localMigrationContent(f, migrations.get(f) ?? "")
      )
    ),
    Bun.write(
      join(UPGRADE_DIR, "versions.tsv"),
      `# pgflow release<TAB>its last upstream migration; the last line is the version this image installs\n${lastMigrations.join("\n")}\n`
    ),
    Bun.write(
      join(UPGRADE_DIR, "aza-overrides.sql"),
      stripTrailingWhitespace(
        formatSql(
          `-- Generated by: bun scripts/pgflow/generate-schema.ts (do not edit)\n${overrides}`,
          sqlConfig
        )
      )
    ),
  ]);
  console.log(
    `✅ Upgrade fixtures: ${migrationFiles.length} migrations, ${releases.length} releases in ${UPGRADE_DIR}`
  );
}

async function main(): Promise<void> {
  const options = parseArgs();

  console.log("═".repeat(70));
  console.log(`pgflow Schema Generator - v${options.version}`);
  console.log("═".repeat(70));
  console.log(`Tag: ${options.tag}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log("═".repeat(70));
  console.log("");

  // Discover the upstream file set instead of carrying a fragile local copy.
  const schemaFiles = await listUpstreamSql(options.tag, SCHEMAS_DIR);
  const schemas = await fetchAll(options.tag, SCHEMAS_DIR, schemaFiles, options.verbose);

  // Generate combined schema
  const combinedSchema = generateCombinedSchema(options.version, schemaFiles, schemas);
  const outputPath = join(FIXTURES_DIR, "schema.sql");

  console.log("");
  console.log(
    `Combined schema: ${combinedSchema.length} bytes, ${combinedSchema.split("\n").length} lines`
  );

  // Validate key v0.9.0+ indicators if version >= 0.9.0
  const versionParts = options.version.split(".").map(Number);
  const major = versionParts[0] ?? 0;
  const minor = versionParts[1] ?? 0;
  if (major > 0 || (major === 0 && minor >= 9)) {
    console.log("");
    console.log("Validating v0.9.0+ schema indicators...");

    const schemaLower = combinedSchema.toLowerCase();
    const checks = [
      {
        // Matches only a pgflow-owned definition: 0.17 schemas mention pgmq's read_with_poll in comments.
        name: "pgflow.read_with_poll removed",
        pass: !/create\s+(or\s+replace\s+)?function\s+pgflow\.read_with_poll\b/.test(schemaLower),
        fail: "pgflow.read_with_poll should not be defined in v0.9.0+",
      },
      {
        name: "set_vt_batch returns table",
        pass: schemaLower.includes("set_vt_batch") && schemaLower.includes("returns table"),
        fail: "set_vt_batch should return TABLE format in v0.9.0+",
      },
      {
        name: "headers column present",
        pass: schemaLower.includes("headers jsonb"),
        fail: "headers JSONB column should be present for pgmq 1.5.1 compatibility",
      },
      {
        name: "condition resolver is defined when referenced",
        pass:
          !schemaLower.includes("cascade_resolve_conditions(") ||
          schemaLower.includes("create or replace function pgflow.cascade_resolve_conditions"),
        fail: "cascade_resolve_conditions is referenced but its schema file was not included",
      },
    ];

    let allPassed = true;
    for (const check of checks) {
      if (check.pass) {
        console.log(`  ✅ ${check.name}`);
      } else {
        console.log(`  ❌ ${check.name}: ${check.fail}`);
        allPassed = false;
      }
    }

    if (!allPassed) {
      console.error("\n❌ Schema validation failed - content may not match expected version");
      process.exit(1);
    }
  }

  // Write schema file
  if (options.dryRun) {
    console.log("");
    console.log("Dry run - would write:");
    console.log(`  ${outputPath}`);
  } else {
    const sqlConfig = await loadSqlFormatterConfig();
    await Bun.write(outputPath, stripTrailingWhitespace(formatSql(combinedSchema, sqlConfig)));
    console.log(`\n✅ Written (formatted): ${outputPath}`);
    await writeUpgradeFixtures(options, schemas, sqlConfig);
  }

  console.log("");
  console.log("═".repeat(70));
  console.log("Next steps:");
  console.log("  1. Review the generated schema");
  console.log("  2. Run: bun run validate");
  console.log("  3. Run: bun run test:pgflow");
  console.log("═".repeat(70));
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
