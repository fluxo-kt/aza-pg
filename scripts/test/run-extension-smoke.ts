#!/usr/bin/env bun
/**
 * Extension smoke test
 * Creates extensions in dependency order and runs basic functional tests
 *
 * Usage: bun scripts/test/run-extension-smoke.ts [image]
 * Default image: aza-pg:test
 */

import { $ } from "bun";
import { join } from "node:path";
import { dockerCleanup } from "../utils/docker";

// Get script directory
const scriptDir = import.meta.dir;
const projectRoot = join(scriptDir, "../..");
const manifestPath = join(projectRoot, "docker/postgres/extensions.manifest.json");
const ENTRYPOINT_READY_MARKER = "PostgreSQL init process complete; ready for start up.";

interface ManifestEntry {
  name: string;
  kind: string;
  dependencies?: string[];
  enabled?: boolean;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
    preloadOnly?: boolean;
    excludeFromAutoTests?: boolean;
  };
}

interface Manifest {
  entries: ManifestEntry[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function dockerExec(containerName: string, args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(["docker", "exec", containerName, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function readContainerLogs(containerName: string): Promise<CommandResult> {
  const proc = Bun.spawn(["docker", "logs", containerName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function printContainerLogs(containerName: string): Promise<void> {
  const { stdout, stderr } = await readContainerLogs(containerName);
  printCommandOutput({ stdout, stderr }, "container ");
}

function printCommandOutput(
  { stdout, stderr }: Pick<CommandResult, "stdout" | "stderr">,
  prefix = ""
): void {
  if (stdout.trim()) {
    console.error(`[${prefix}stdout]\n${stdout.trim()}`);
  }
  if (stderr.trim()) {
    console.error(`[${prefix}stderr]\n${stderr.trim()}`);
  }
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Topologically sort extensions by dependencies
 */
function topologicalSort(extensions: ManifestEntry[]): string[] {
  const extNames = new Set(extensions.map((e) => e.name));

  // Build dependency graph
  const deps = new Map<string, Set<string>>();
  for (const entry of extensions) {
    const filtered = (entry.dependencies ?? []).filter((dep) => extNames.has(dep));
    deps.set(entry.name, new Set(filtered));
  }

  // Build dependents graph (reverse)
  const dependents = new Map<string, Set<string>>();
  for (const [name, dset] of deps.entries()) {
    for (const dep of dset) {
      if (!dependents.has(dep)) {
        dependents.set(dep, new Set());
      }
      dependents.get(dep)!.add(name);
    }
  }

  // Calculate in-degree
  const indegree = new Map<string, number>();
  for (const [name, dset] of deps.entries()) {
    indegree.set(name, dset.size);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(name);
    }
  }
  queue.sort(); // Deterministic order

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    const children = Array.from(dependents.get(current) ?? []).sort();
    for (const child of children) {
      const newDegree = indegree.get(child)! - 1;
      indegree.set(child, newDegree);
      if (newDegree === 0) {
        queue.push(child);
      }
    }
  }

  // Check for cycles
  if (order.length !== deps.size) {
    const missing = Array.from(deps.keys()).filter((name) => !order.includes(name));
    throw new Error(`Dependency cycle detected involving: ${missing.join(", ")}`);
  }

  return order;
}

/**
 * Main test function
 */
async function main(): Promise<void> {
  const image = Bun.argv[2] ?? Bun.env.POSTGRES_IMAGE ?? "aza-pg-ci:test";
  const containerName = `aza-pg-ext-smoke-${process.pid}`;
  const postgresPassword = Bun.env.POSTGRES_PASSWORD ?? "postgres";

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    await dockerCleanup(containerName);
  };

  // Set up cleanup on exit
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    // Read and parse manifest
    const manifestFile = Bun.file(manifestPath);
    const manifestText = await manifestFile.text();
    const manifest: Manifest = JSON.parse(manifestText);

    // Filter only extensions, excluding those requiring shared_preload_libraries
    // and those that are disabled in the manifest
    const extensions = manifest.entries.filter((entry) => {
      if (entry.kind !== "extension") {
        return false;
      }
      // Skip extensions that are disabled
      if (entry.enabled === false) {
        console.log(`[info] Skipping ${entry.name} (disabled in manifest)`);
        return false;
      }
      // Skip extensions that require shared_preload_libraries
      if (entry.runtime?.sharedPreload === true) {
        console.log(`[info] Skipping ${entry.name} (requires shared_preload_libraries)`);
        return false;
      }
      if (entry.runtime?.preloadOnly === true) {
        console.log(`[info] Skipping ${entry.name} (not a CREATE EXTENSION target)`);
        return false;
      }
      if (entry.runtime?.excludeFromAutoTests === true) {
        console.log(`[info] Skipping ${entry.name} (excluded from automated tests)`);
        return false;
      }
      return true;
    });

    // Sort extensions by dependencies
    let extensionOrder: string[];
    try {
      extensionOrder = topologicalSort(extensions);
    } catch (error) {
      console.error(
        `[smoke] Failed to derive extension order: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }

    // Launch container
    console.log(`[smoke] Launching container ${containerName} with image ${image}...`);
    await $`docker run -d --rm --name ${containerName} -e POSTGRES_PASSWORD=${postgresPassword} ${image}`.quiet();

    // Wait for PostgreSQL to accept connections
    console.log("[smoke] Waiting for PostgreSQL to accept connections...");
    let attempt = 0;
    const maxAttempts = 60;

    while (attempt < maxAttempts) {
      const logs = await readContainerLogs(containerName);
      if (
        logs.stdout.includes(ENTRYPOINT_READY_MARKER) ||
        logs.stderr.includes(ENTRYPOINT_READY_MARKER)
      ) {
        const ready = await dockerExec(containerName, ["pg_isready", "-U", "postgres"]);
        const sqlReady =
          ready.exitCode === 0
            ? await dockerExec(containerName, [
                "psql",
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-tAc",
                "SELECT 1",
              ])
            : undefined;
        if (ready.exitCode === 0 && sqlReady?.exitCode === 0 && sqlReady.stdout.trim() === "1") {
          break;
        }
      }
      await Bun.sleep(2000);
      attempt++;
    }

    if (attempt === maxAttempts) {
      console.error(`[smoke] postgres did not become ready in time (${maxAttempts} attempts)`);
      await printContainerLogs(containerName);
      await cleanup();
      process.exit(1);
    }

    console.log(`[smoke] Creating extensions (${extensionOrder.length} total)`);

    // Create each extension
    for (const ext of extensionOrder) {
      // Check if extension control file is present
      const available = await dockerExec(containerName, [
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-tAc",
        `SELECT 1 FROM pg_available_extensions WHERE name = ${quoteSqlLiteral(ext)}`,
      ]);
      if (available.exitCode !== 0 || available.stdout.trim() !== "1") {
        console.error(`  - ${ext} FAILED: extension is enabled but unavailable`);
        printCommandOutput(available);
        await printContainerLogs(containerName);
        await cleanup();
        process.exit(1);
      }

      // Create extension
      const created = await dockerExec(containerName, [
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `CREATE EXTENSION IF NOT EXISTS ${quoteSqlIdentifier(ext)} CASCADE;`,
      ]);
      if (created.exitCode === 0) {
        console.log(`  - ${ext} created`);
        continue;
      }

      console.error(`  - ${ext} FAILED (exit ${created.exitCode})`);
      printCommandOutput(created);
      await printContainerLogs(containerName);
      await cleanup();
      process.exit(1);
    }

    // Run functional tests (skip tests for disabled/preload-dependent extensions)
    console.log("[smoke] Running functional tests...");
    try {
      const testSQL = `
SELECT '[-1,1]'::vector(2) AS vector_smoke;
SELECT extname FROM pg_extension WHERE extname IN ('timescaledb', 'vectorscale');
SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries';
`;
      const functional = await dockerExec(containerName, [
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        testSQL,
      ]);
      if (functional.exitCode === 0) {
        console.log(functional.stdout.trim());
      } else {
        console.error(`[smoke] Functional tests failed (exit ${functional.exitCode})`);
        printCommandOutput(functional);
        await printContainerLogs(containerName);
        await cleanup();
        process.exit(1);
      }
    } catch (error) {
      console.error(`[smoke] Functional test runner failed: ${String(error)}`);
      await cleanup();
      process.exit(1);
    }

    console.log("[smoke] Extension smoke test completed successfully.");

    // Cleanup
    await cleanup();
  } catch (error) {
    console.error(`[smoke] Test failed: ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }
}

// Run main function
main();
