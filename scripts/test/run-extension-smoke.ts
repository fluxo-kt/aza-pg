#!/usr/bin/env bun
/**
 * Extension smoke test
 * Creates extensions in dependency order and runs basic functional tests
 *
 * Usage: bun scripts/test/run-extension-smoke.ts [image]
 * Default image: aza-pg:test
 */

import { $ } from "bun";
import { join } from "path";
import { dockerCleanup } from "../utils/docker";

// Get script directory
const scriptDir = import.meta.dir;
const projectRoot = join(scriptDir, "../..");
const manifestPath = join(projectRoot, "docker/postgres/extensions.manifest.json");

interface ManifestEntry {
  name: string;
  kind: string;
  dependencies?: string[];
  enabled?: boolean;
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
  };
}

interface Manifest {
  entries: ManifestEntry[];
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
      try {
        await $`docker exec ${containerName} pg_isready -U postgres`.quiet();
        break;
      } catch {
        // Not ready yet
      }
      await Bun.sleep(2000);
      attempt++;
    }

    if (attempt === maxAttempts) {
      console.error(`[smoke] postgres did not become ready in time (${maxAttempts} attempts)`);
      await cleanup();
      process.exit(1);
    }

    console.log(`[smoke] Creating extensions (${extensionOrder.length} total)`);

    // Create each extension
    for (const ext of extensionOrder) {
      // Check if extension control file is present
      try {
        const available =
          await $`docker exec ${containerName} psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_available_extensions WHERE name = '${ext}'"`.text();
        if (!available.includes("1")) {
          console.log(`  - ${ext} (skipped; control file not present)`);
          continue;
        }
      } catch {
        console.log(`  - ${ext} (skipped; control file not present)`);
        continue;
      }

      // Create extension
      try {
        await $`docker exec ${containerName} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS \"${ext}\" CASCADE;"`.quiet();
        console.log(`  - ${ext} created`);
      } catch (error) {
        console.error(
          `  - ${ext} FAILED: ${error instanceof Error ? error.message : String(error)}`
        );
        await cleanup();
        process.exit(1);
      }
    }

    // Run functional tests
    console.log("[smoke] Running functional tests...");
    try {
      const testSQL = `
SELECT '[-1,1]'::vector(2) AS vector_smoke;
SELECT PostGIS_Version() AS postgis_version;
SELECT partman_version() AS partman_version;
SELECT current_setting('timescaledb.telemetry_level') AS timescaledb_telemetry;
SELECT extname FROM pg_extension WHERE extname IN ('timescaledb', 'vectorscale');
SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries';
`;
      await $`docker exec ${containerName} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c ${testSQL}`;
    } catch (error) {
      console.error(
        `[smoke] Functional tests failed: ${error instanceof Error ? error.message : String(error)}`
      );
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
