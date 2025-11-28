#!/usr/bin/env bun
/**
 * Extension Size Regression Checker
 *
 * Tracks .so file sizes for known large extensions to detect unexpected bloat.
 * This is a non-critical check (warn-only) that helps identify build issues.
 *
 * Baseline sizes (approximate, for PostgreSQL 18):
 * - timescaledb: ~3-5MB
 * - pg_stat_monitor: ~2-3MB
 * - pgvector: ~1-2MB
 * - postgis: ~4-6MB (large due to GEOS/PROJ dependencies)
 * - pgroonga: ~2-4MB
 *
 * Usage:
 *   bun scripts/check-size-regression.ts                    # Check sizes (requires Docker build)
 *   bun scripts/check-size-regression.ts --baseline-only    # Show baselines without checking
 *
 * Environment:
 *   POSTGRES_IMAGE=<image>   # Override image name (default: aza-pg:pg18)
 *   REQUIRE_DOCKER=true      # Fail if Docker/image unavailable (for CI/publish)
 */

import { getErrorMessage } from "./utils/errors";
import { join } from "node:path";
import { error, info, section, success, warning } from "./utils/logger.ts";

// Derive project root from current file location (scripts/check-size-regression.ts)
const PROJECT_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(PROJECT_ROOT, "docker/postgres/extensions.manifest.json");
const SIZE_BASELINES_PATH = join(import.meta.dir, "config/size-baselines.json");

interface Extension {
  name: string;
  kind: string;
  enabled?: boolean;
}

interface Manifest {
  entries: Extension[];
}

interface SizeBaseline {
  min: number;
  max: number;
  description: string;
}

/**
 * Known large extensions with baseline sizes (in MB)
 * Loaded from config file for easier maintenance
 */
let SIZE_BASELINES: Record<string, SizeBaseline> = {};

/**
 * Load size baselines from config file
 */
async function loadSizeBaselines(): Promise<void> {
  try {
    const file = Bun.file(SIZE_BASELINES_PATH);
    if (!(await file.exists())) {
      error(`Size baselines config not found at ${SIZE_BASELINES_PATH}`);
      process.exit(1);
    }
    SIZE_BASELINES = await file.json();
  } catch (err) {
    error(`Failed to load size baselines: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Maximum allowed size increase threshold (as percentage)
 */
const MAX_SIZE_INCREASE_PERCENT = 20;

/**
 * Print baseline information
 */
function showBaselines(): void {
  section("Extension Size Baselines");

  info("Known large extensions tracked for size regression:");
  console.log("");

  for (const [name, baseline] of Object.entries(SIZE_BASELINES)) {
    console.log(`  ${name}:`);
    console.log(`    Range: ${baseline.min.toFixed(1)}MB - ${baseline.max.toFixed(1)}MB`);
    console.log(`    Description: ${baseline.description}`);
    console.log("");
  }

  info(`Maximum allowed size increase: ${MAX_SIZE_INCREASE_PERCENT}% above baseline max`);
}

/**
 * Check if Docker is available
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Docker image exists
 */
async function imageExists(imageName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "images", "-q", imageName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get .so file size from Docker image
 */
async function getSoSize(imageName: string, extensionName: string): Promise<number | null> {
  try {
    // Common locations for .so files
    const pgVersion = Bun.env.PG_VERSION ?? "18";
    const possiblePaths = [
      `/usr/lib/postgresql/${pgVersion}/lib/${extensionName}.so`,
      `/usr/share/postgresql/${pgVersion}/extension/${extensionName}.so`,
    ];

    for (const path of possiblePaths) {
      const proc = Bun.spawn(["docker", "run", "--rm", imageName, "stat", "-c", "%s", path], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const output = await new Response(proc.stdout).text();
        const bytes = parseInt(output.trim(), 10);
        if (!isNaN(bytes)) {
          return bytes / (1024 * 1024); // Convert to MB
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check size regression for an extension
 */
async function checkExtensionSize(
  imageName: string,
  extensionName: string,
  baseline: { min: number; max: number; description: string }
): Promise<{ passed: boolean; message: string }> {
  const size = await getSoSize(imageName, extensionName);

  if (size === null) {
    return {
      passed: true,
      message: `${extensionName}: .so file not found (may not produce .so or disabled)`,
    };
  }

  const maxAllowed = baseline.max * (1 + MAX_SIZE_INCREASE_PERCENT / 100);

  if (size > maxAllowed) {
    return {
      passed: false,
      message: `${extensionName}: ${size.toFixed(2)}MB exceeds baseline max ${baseline.max.toFixed(1)}MB + ${MAX_SIZE_INCREASE_PERCENT}% (${maxAllowed.toFixed(1)}MB)`,
    };
  } else if (size < baseline.min) {
    return {
      passed: true,
      message: `${extensionName}: ${size.toFixed(2)}MB (below baseline, possible optimization or build change)`,
    };
  } else {
    return {
      passed: true,
      message: `${extensionName}: ${size.toFixed(2)}MB (within expected range ${baseline.min.toFixed(1)}-${baseline.max.toFixed(1)}MB)`,
    };
  }
}

async function main() {
  const args = Bun.argv.slice(2);

  // Load size baselines from config
  await loadSizeBaselines();

  if (args.includes("--baseline-only")) {
    showBaselines();
    return;
  }

  section("Extension Size Regression Check");

  // REQUIRE_DOCKER=true makes this check fail (not skip) when Docker/image unavailable
  // This is used in publish workflow to ensure size regression checks actually run
  const requireDocker = Bun.env.REQUIRE_DOCKER === "true";

  // Check if Docker is available
  if (!(await isDockerAvailable())) {
    if (requireDocker) {
      error("Docker not available - REQUIRE_DOCKER is set, failing instead of skipping");
      process.exit(1);
    }
    warning("Docker not available - size regression check skipped");
    info("This check requires a built Docker image to inspect .so files");
    info("Run with --baseline-only to see tracked extensions");
    return;
  }

  // Load manifest to see which extensions are enabled
  const manifestFile = Bun.file(MANIFEST_PATH);
  if (!(await manifestFile.exists())) {
    error(`Manifest not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest: Manifest = await manifestFile.json();
  const enabledExtensions = manifest.entries.filter((e) => e.enabled !== false);

  // Determine which image to check
  const imageName = Bun.env.POSTGRES_IMAGE || "aza-pg:pg18";
  info(`Checking image: ${imageName}`);

  if (!(await imageExists(imageName))) {
    if (requireDocker) {
      error(
        `Docker image '${imageName}' not found - REQUIRE_DOCKER is set, failing instead of skipping`
      );
      info("Build the image first: docker build -t aza-pg:pg18 -f docker/postgres/Dockerfile .");
      info("Or set POSTGRES_IMAGE env var to point to an existing image");
      process.exit(1);
    }
    warning(`Docker image '${imageName}' not found - size regression check skipped`);
    info("Build the image first: docker build -t aza-pg:pg18 -f docker/postgres/Dockerfile .");
    info("Or set POSTGRES_IMAGE env var to point to an existing image");
    return;
  }

  // Check sizes for extensions in our baseline list that are enabled
  const enabledExtensionNames = new Set(enabledExtensions.map((e) => e.name));
  const extensionsToCheck = Object.keys(SIZE_BASELINES).filter((name) =>
    enabledExtensionNames.has(name)
  );

  if (extensionsToCheck.length === 0) {
    info("No tracked large extensions found in enabled extensions");
    return;
  }

  info(`Checking ${extensionsToCheck.length} large extensions...`);
  console.log("");

  const results: { passed: boolean; message: string }[] = [];

  for (const extensionName of extensionsToCheck) {
    const baseline = SIZE_BASELINES[extensionName];
    if (!baseline) {
      continue; // Shouldn't happen, but satisfy TypeScript
    }
    const result = await checkExtensionSize(imageName, extensionName, baseline);
    results.push(result);

    if (result.passed) {
      success(result.message);
    } else {
      warning(result.message);
    }
  }

  console.log("");

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    warning(
      `${failed.length} extension(s) exceeded size baselines (non-critical - review changes)`
    );
    info("This may indicate:");
    info("  - Dependency updates that increased binary size");
    info("  - New features or functionality added");
    info("  - Build configuration changes");
    info("  - Update SIZE_BASELINES if intentional");
  } else {
    success("All extension sizes within expected ranges!");
  }

  // Note: This is a non-critical check, so we don't exit with error
}

main().catch((err) => {
  error(`Size regression check error: ${getErrorMessage(err)}`);
  process.exit(1);
});
