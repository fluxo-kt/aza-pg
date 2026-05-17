#!/usr/bin/env bun
/**
 * pgflow Schema Generator
 *
 * Fetches and combines all pgflow schema files from a specific GitHub tag
 * into a single SQL file for use in tests.
 *
 * Usage:
 *   bun scripts/pgflow/generate-schema.ts 0.9.0
 *   bun scripts/pgflow/generate-schema.ts 0.9.0 --update-install
 *   bun scripts/pgflow/generate-schema.ts 0.9.0 --dry-run
 *
 * Options:
 *   --update-install  Also update install.ts version constant and file path
 *   --dry-run         Show what would be done without writing files
 *   --verbose         Show detailed progress
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format as formatSql } from "sql-formatter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const FIXTURES_DIR = join(ROOT_DIR, "tests/fixtures/pgflow");
const INSTALL_TS = join(FIXTURES_DIR, "install.ts");
const SQL_FORMATTER_CONFIG = join(ROOT_DIR, ".sql-formatter.json");
const SCHEMA_DIRECTORY_API =
  "https://api.github.com/repos/pgflow-dev/pgflow/contents/pkgs/core/schemas";

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
  updateInstall: boolean;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));

  if (!version) {
    console.error("Usage: bun scripts/pgflow/generate-schema.ts <version> [options]");
    console.error("");
    console.error("Examples:");
    console.error("  bun scripts/pgflow/generate-schema.ts 0.9.0");
    console.error("  bun scripts/pgflow/generate-schema.ts 0.9.0 --update-install");
    console.error("  bun scripts/pgflow/generate-schema.ts 0.9.0 --dry-run --verbose");
    process.exit(1);
  }

  // Normalize version (remove 'v' prefix if present)
  const normalizedVersion = version.replace(/^v/, "");
  const tag = `pgflow@${normalizedVersion}`;

  return {
    version: normalizedVersion,
    tag,
    updateInstall: args.includes("--update-install"),
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };
}

function getSchemaUrl(tag: string, filename: string): string {
  const encodedTag = encodeURIComponent(tag);
  return `https://raw.githubusercontent.com/pgflow-dev/pgflow/${encodedTag}/pkgs/core/schemas/${filename}`;
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

function localSchemaContent(filename: string, upstreamContent: string): string {
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

function stripTrailingWhitespace(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

async function fetchSchemaFilenames(tag: string): Promise<string[]> {
  const url = `${SCHEMA_DIRECTORY_API}?ref=${encodeURIComponent(tag)}`;
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
      `Failed to list pgflow schema directory: ${response.status} ${response.statusText}.${authHint}`
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

async function fetchSchemaFile(tag: string, filename: string, verbose: boolean): Promise<string> {
  const url = getSchemaUrl(tag, filename);

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

async function fetchAllSchemas(
  tag: string,
  schemaFiles: readonly string[],
  verbose: boolean
): Promise<Map<string, string>> {
  const schemas = new Map<string, string>();

  console.log(`Fetching ${schemaFiles.length} schema files from ${tag}...`);

  for (const filename of schemaFiles) {
    const content = await fetchSchemaFile(tag, filename, verbose);
    schemas.set(filename, content);
  }

  console.log(`✅ Fetched all ${schemas.size} files`);
  return schemas;
}

function generateCombinedSchema(
  version: string,
  schemaFiles: readonly string[],
  schemas: Map<string, string>
): string {
  const header = `-- pgflow v${version} Schema
-- Source: https://github.com/pgflow-dev/pgflow/tree/pgflow@${version}/pkgs/core/schemas/
-- Generated by: bun scripts/pgflow/generate-schema.ts ${version}
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

  return sections.join("\n");
}

async function updateInstallTs(version: string, dryRun: boolean, verbose: boolean): Promise<void> {
  const content = await Bun.file(INSTALL_TS).text();

  // Update PGFLOW_VERSION constant
  const versionPattern = /export const PGFLOW_VERSION = "[^"]+"/;
  const schemaPattern = /const SCHEMA_FILE = join\(__dirname, "schema-v[^"]+\.sql"\)/;

  if (!versionPattern.test(content) || !schemaPattern.test(content)) {
    throw new Error(
      "install.ts schema/version anchors changed; update generator before continuing"
    );
  }

  let newContent = content.replace(versionPattern, `export const PGFLOW_VERSION = "${version}"`);
  newContent = newContent.replace(
    schemaPattern,
    `const SCHEMA_FILE = join(__dirname, "schema-v${version}.sql")`
  );

  if (newContent === content) {
    console.log("ℹ️  install.ts already up to date");
    return;
  }

  if (dryRun) {
    console.log(`Would update install.ts with version ${version}`);
    if (verbose) {
      console.log("  - PGFLOW_VERSION constant");
      console.log("  - SCHEMA_FILE path");
    }
    return;
  }

  await Bun.write(INSTALL_TS, newContent);
  console.log(`✅ Updated install.ts to v${version}`);
}

async function findOldSchemas(currentVersion: string): Promise<string[]> {
  const glob = new Bun.Glob("schema-v*.sql");
  const files: string[] = [];

  for await (const file of glob.scan(FIXTURES_DIR)) {
    if (!file.includes(`v${currentVersion}`)) {
      files.push(file);
    }
  }

  return files;
}

async function main(): Promise<void> {
  const options = parseArgs();

  console.log("═".repeat(70));
  console.log(`pgflow Schema Generator - v${options.version}`);
  console.log("═".repeat(70));
  console.log(`Tag: ${options.tag}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log(`Update install.ts: ${options.updateInstall}`);
  console.log("═".repeat(70));
  console.log("");

  // Discover the upstream file set instead of carrying a fragile local copy.
  const schemaFiles = await fetchSchemaFilenames(options.tag);

  // Fetch all schema files
  const schemas = await fetchAllSchemas(options.tag, schemaFiles, options.verbose);

  // Generate combined schema
  const combinedSchema = generateCombinedSchema(options.version, schemaFiles, schemas);
  const outputPath = join(FIXTURES_DIR, `schema-v${options.version}.sql`);

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
        name: "read_with_poll removed",
        pass: !schemaLower.includes("read_with_poll"),
        fail: "read_with_poll should not exist in v0.9.0+",
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
    // Write raw schema first
    await Bun.write(outputPath, combinedSchema);
    console.log(`\n✅ Written: ${outputPath}`);

    // Format the schema file with sql-formatter for consistency
    console.log("📝 Formatting schema with sql-formatter...");
    const sqlConfig = await loadSqlFormatterConfig();
    const rawContent = await Bun.file(outputPath).text();
    const formattedContent = formatSql(rawContent, sqlConfig);
    await Bun.write(outputPath, stripTrailingWhitespace(formattedContent));
    console.log("✅ Schema formatted");
  }

  // Update install.ts if requested
  if (options.updateInstall) {
    console.log("");
    await updateInstallTs(options.version, options.dryRun, options.verbose);
  }

  // List old schema files that could be deleted
  const oldSchemas = await findOldSchemas(options.version);
  if (oldSchemas.length > 0) {
    console.log("");
    console.log("Old schema files that can be deleted:");
    for (const file of oldSchemas) {
      console.log(`  rm ${join(FIXTURES_DIR, file)}`);
    }
  }

  console.log("");
  console.log("═".repeat(70));
  console.log("Next steps:");
  console.log("  1. Review the generated schema");
  console.log("  2. Run: bun run validate");
  console.log("  3. Run: bun run test:pgflow");
  if (oldSchemas.length > 0) {
    console.log(`  4. Delete old schema files if tests pass`);
  }
  console.log("═".repeat(70));
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
