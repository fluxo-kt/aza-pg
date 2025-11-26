#!/usr/bin/env bun
/**
 * pgflow Container Setup & Lifecycle Management
 *
 * Handles complete pgflow container lifecycle with multi-stage initialization:
 * - Stage 1: Container startup
 * - Stage 2: Container running verification
 * - Stage 3: PostgreSQL ready (pg_isready)
 * - Stage 4: pgflow schema installation (7 tables + 13+ functions)
 * - Stage 5: Final verification
 *
 * Usage:
 *   Setup container:
 *     bun scripts/docker/setup-pgflow-container.ts --name my-container --image aza-pg:latest
 *
 *   CI usage:
 *     bun scripts/docker/setup-pgflow-container.ts \
 *       --name publish-pgflow-test \
 *       --image "ghcr.io/fluxo-kt/aza-pg-testing:testing-abc123" \
 *       --password test_pass \
 *       --database test_db \
 *       --memory 2048 \
 *       --timeout 120 \
 *       --diagnostic-dir /tmp/diagnostics
 *
 *   Cleanup only:
 *     bun scripts/docker/setup-pgflow-container.ts --name my-container --cleanup-only
 *
 *   Verify only:
 *     bun scripts/docker/setup-pgflow-container.ts --name my-container --verify-only
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Container setup failed
 *   2 - pgflow schema timeout
 *   3 - Cleanup failed
 */

import { $ } from "bun";
import { parseArgs } from "node:util";
import { dockerCleanup } from "../utils/docker";
import { error, info, success, warning, section } from "../utils/logger";
import { installPgflowSchema } from "../../tests/fixtures/pgflow/install";

interface SetupOptions {
  name: string;
  image: string;
  password: string;
  database: string;
  memory: number;
  workloadType: string;
  timeout: number;
  cleanupOnly: boolean;
  verifyOnly: boolean;
  diagnosticDir?: string;
}

/**
 * Wait for PostgreSQL to accept connections
 */
async function waitForPostgres(container: string, timeout: number): Promise<boolean> {
  const start = Date.now();
  const timeoutMs = timeout * 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await $`docker exec ${container} pg_isready -U postgres`.nothrow();
      if (result.exitCode === 0) {
        return true;
      }
    } catch {
      // Ignore errors, retry
    }
    await Bun.sleep(2000);
  }

  return false;
}

/**
 * Wait for pgflow schema to be fully initialized
 * Verifies: 1 schema + 7 tables + 13+ functions
 */
async function waitForPgflowSchema(
  container: string,
  database: string,
  timeout: number
): Promise<boolean> {
  const verifyQuery = `
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgflow')
        AND (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow') = 7
        AND (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow') >= 13
        THEN 1
        ELSE 0
      END
  `;

  const start = Date.now();
  const timeoutMs = timeout * 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const result =
        await $`docker exec ${container} psql -U postgres -d ${database} -tAc ${verifyQuery}`.nothrow();
      if (result.exitCode === 0 && result.stdout.toString().trim() === "1") {
        return true;
      }
    } catch {
      // Ignore errors, retry
    }
    await Bun.sleep(5000);
  }

  return false;
}

/**
 * Capture diagnostic information on failure
 */
async function captureDiagnostics(container: string, dir: string): Promise<void> {
  try {
    await $`mkdir -p ${dir}`;

    // Container logs
    info("Capturing container logs...");
    const logs = await $`docker logs ${container}`.nothrow().text();
    await Bun.write(`${dir}/container-logs.txt`, logs);

    // Container state
    const state = await $`docker inspect ${container} --format "{{json .State}}"`.nothrow().text();
    await Bun.write(`${dir}/container-state.json`, state);

    // pgflow schema status
    const schemaStatus = await $`docker exec ${container} psql -U postgres -c "
      SELECT 'Schema' as type, CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgflow') THEN 'EXISTS' ELSE 'MISSING' END as status
      UNION ALL
      SELECT 'Tables', (SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'pgflow')
      UNION ALL
      SELECT 'Functions', (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow')
      UNION ALL
      SELECT 'pgmq ext', CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN 'EXISTS' ELSE 'MISSING' END
    "`
      .nothrow()
      .text();
    await Bun.write(`${dir}/schema-status.txt`, schemaStatus);

    info(`Diagnostics captured to: ${dir}`);
  } catch (err) {
    warning(`Failed to capture diagnostics: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Setup pgflow container with multi-stage initialization
 */
async function setupPgflowContainer(options: SetupOptions): Promise<number> {
  section(`pgflow Container Setup: ${options.name}`);
  info(`Image: ${options.image}`);
  info(`Memory: ${options.memory}MB`);
  info(`Timeout: ${options.timeout}s`);

  // Stage 1: Start container
  info("Stage 1: Starting container...");
  const startResult = await $`docker run -d \
    --name ${options.name} \
    -e POSTGRES_PASSWORD=${options.password} \
    -e POSTGRES_DB=${options.database} \
    -e POSTGRES_MEMORY=${options.memory} \
    -e POSTGRES_WORKLOAD_TYPE=${options.workloadType} \
    ${options.image}`.nothrow();

  if (startResult.exitCode !== 0) {
    error("Failed to start container");
    error(startResult.stderr.toString());
    return 1;
  }
  success("✓ Container started");

  // Stage 2: Verify container is running
  info("Stage 2: Verifying container state...");
  await Bun.sleep(2000); // Brief settle time

  const psResult =
    await $`docker ps --filter name=${options.name} --filter status=running --format "{{.Names}}"`.nothrow();
  if (!psResult.stdout.toString().includes(options.name)) {
    error("Container not running");
    const inspect =
      await $`docker inspect ${options.name} --format "{{.State.Status}} - {{.State.Error}}"`
        .nothrow()
        .text();
    error(`Container state: ${inspect}`);

    if (options.diagnosticDir) {
      await captureDiagnostics(options.name, options.diagnosticDir);
    }
    return 1;
  }
  success("✓ Container running");

  // Stage 3: Wait for PostgreSQL ready
  info(`Stage 3: Waiting for PostgreSQL (timeout: ${options.timeout}s)...`);
  if (!(await waitForPostgres(options.name, options.timeout))) {
    error(`PostgreSQL not ready after ${options.timeout}s`);

    if (options.diagnosticDir) {
      await captureDiagnostics(options.name, options.diagnosticDir);
    }
    return 1;
  }
  success("✓ PostgreSQL accepting connections");

  // Stage 4: Install pgflow schema
  info("Stage 4: Installing pgflow schema...");
  const installResult = await installPgflowSchema(options.name, options.database);
  if (!installResult.success) {
    error(`Failed to install pgflow schema: ${installResult.stderr}`);

    if (options.diagnosticDir) {
      await captureDiagnostics(options.name, options.diagnosticDir);
    }
    return 2;
  }
  success(
    `✓ pgflow schema installed (${installResult.tablesCreated} tables, ${installResult.functionsCreated} functions)`
  );

  // Stage 5: Final verification
  info("Stage 5: Final verification...");
  const statsResult =
    await $`docker exec ${options.name} psql -U postgres -d ${options.database} -tAc "
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'pgflow') || ',' ||
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'pgflow')
  "`.nothrow();

  if (statsResult.exitCode === 0) {
    const parts = statsResult.stdout.toString().trim().split(",").map(Number);

    const tables = parts[0] ?? 0;
    const functions = parts[1] ?? 0;

    info(`pgflow schema: ${tables} tables, ${functions} functions`);

    if (tables === 7 && functions >= 13) {
      success(`✅ Container ${options.name} ready for testing`);
      return 0;
    } else {
      warning(`Schema incomplete: ${tables}/7 tables, ${functions}/13+ functions`);
      return 2;
    }
  } else {
    error("Failed to verify schema");
    return 2;
  }
}

/**
 * Cleanup pgflow container
 */
async function cleanupPgflowContainer(name: string): Promise<number> {
  info(`Cleaning up container: ${name}`);

  try {
    await dockerCleanup(name);

    // Verify removal
    const remaining = await $`docker ps -a --filter name=${name} --format "{{.Names}}"`
      .nothrow()
      .text();
    if (remaining.includes(name)) {
      warning(`Container ${name} still exists after cleanup`);

      // Force removal
      await $`docker rm -f ${name}`.nothrow();

      // Check again
      const stillThere = await $`docker ps -a --filter name=${name} --format "{{.Names}}"`
        .nothrow()
        .text();
      if (stillThere.includes(name)) {
        error(`Failed to remove container ${name}`);
        return 3;
      }
    }

    success(`✓ Container ${name} removed`);
    return 0;
  } catch (err) {
    error(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
}

/**
 * Verify pgflow container is ready (no setup, just check)
 */
async function verifyPgflowContainer(name: string, database: string): Promise<number> {
  info(`Verifying container: ${name}`);

  // Check if running
  const running =
    await $`docker ps --filter name=${name} --filter status=running --format "{{.Names}}"`
      .nothrow()
      .text();
  if (!running.includes(name)) {
    error("Container not running");
    return 1;
  }

  // Check pgflow schema
  const ready = await waitForPgflowSchema(name, database, 10);
  if (!ready) {
    error("pgflow schema not ready");
    return 2;
  }

  success(`✓ Container ${name} is ready`);
  return 0;
}

// Main execution
if (import.meta.main) {
  // Handle --help before parseArgs
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(
      `
pgflow Container Setup & Lifecycle Management

Usage:
  bun scripts/docker/setup-pgflow-container.ts [OPTIONS]

Options:
  --name NAME             Container name (default: aza-pg-test)
  --image IMAGE           Docker image (default: aza-pg-testing:latest)
  --password PASS         PostgreSQL password (default: postgres)
  --database DB           Database name (default: postgres)
  --memory MB             Memory limit in MB (default: 2048)
  --workload-type TYPE    Workload type: web|oltp|dw|mixed (default: web)
  --timeout SECONDS       Timeout in seconds (default: 120)
  --cleanup-only          Only cleanup existing container
  --verify-only           Only verify container readiness
  --diagnostic-dir DIR    Directory for diagnostic capture on failure
  --help, -h              Show this help message

Examples:
  # Setup pgflow container
  bun scripts/docker/setup-pgflow-container.ts \\
    --name my-container \\
    --image aza-pg:latest

  # CI usage with diagnostics
  bun scripts/docker/setup-pgflow-container.ts \\
    --name publish-pgflow-test \\
    --image "ghcr.io/fluxo-kt/aza-pg-testing:testing-abc123" \\
    --memory 2048 \\
    --timeout 120 \\
    --diagnostic-dir /tmp/diagnostics

  # Cleanup only
  bun scripts/docker/setup-pgflow-container.ts \\
    --name my-container \\
    --cleanup-only

  # Verify only
  bun scripts/docker/setup-pgflow-container.ts \\
    --name my-container \\
    --verify-only

Exit Codes:
  0 - Success
  1 - Container setup failed
  2 - pgflow schema timeout
  3 - Cleanup failed
    `.trim()
    );
    process.exit(0);
  }

  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      name: { type: "string", default: "aza-pg-test" },
      image: { type: "string", default: "aza-pg-testing:latest" },
      password: { type: "string", default: "postgres" },
      database: { type: "string", default: "postgres" },
      memory: { type: "string", default: "2048" },
      "workload-type": { type: "string", default: "web" },
      timeout: { type: "string", default: "120" },
      "cleanup-only": { type: "boolean", default: false },
      "verify-only": { type: "boolean", default: false },
      "diagnostic-dir": { type: "string" },
    },
  });

  const options: SetupOptions = {
    name: values.name!,
    image: values.image!,
    password: values.password!,
    database: values.database!,
    memory: Number(values.memory),
    workloadType: values["workload-type"]!,
    timeout: Number(values.timeout),
    cleanupOnly: values["cleanup-only"]!,
    verifyOnly: values["verify-only"]!,
    diagnosticDir: values["diagnostic-dir"],
  };

  try {
    if (options.cleanupOnly) {
      process.exit(await cleanupPgflowContainer(options.name));
    } else if (options.verifyOnly) {
      process.exit(await verifyPgflowContainer(options.name, options.database));
    } else {
      process.exit(await setupPgflowContainer(options));
    }
  } catch (err) {
    error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
