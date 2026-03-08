#!/usr/bin/env bun
/**
 * Extension Size Regression Checker
 *
 * Tracks .so file sizes for known large extensions to detect unexpected bloat.
 * This is a non-critical check (warn-only) that helps identify build issues.
 *
 * Baselines are maintained in scripts/config/size-baselines.json (single source of truth).
 * Run with --baseline-only to see current tracked extensions and their expected ranges.
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
import { isDockerDaemonRunning } from "./utils/docker";

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

export interface SizeBaseline {
  min: number;
  max: number;
  description: string;
}

/** Discriminates the reason for a warn/fail result — avoids message-text heuristics in summaries. */
export type ResultCategory = "ok" | "not-found" | "below-min" | "tolerance" | "exceeded";

export interface SizeCheckResult {
  passed: boolean;
  warn?: boolean;
  category: ResultCategory;
  message: string;
}

/**
 * Known large extensions with baseline sizes (in MB)
 * Loaded from config file for easier maintenance
 */
let SIZE_BASELINES: Record<string, SizeBaseline> = {};

/**
 * Maximum allowed size increase threshold (as percentage)
 * Exported so tests can use the same threshold constant.
 */
export const MAX_SIZE_INCREASE_PERCENT = 20;

/**
 * Load size baselines from config file.
 * Validates structure: each entry must have 0 ≤ min ≤ max.
 */
async function loadSizeBaselines(): Promise<void> {
  try {
    const file = Bun.file(SIZE_BASELINES_PATH);
    if (!(await file.exists())) {
      error(`Size baselines config not found at ${SIZE_BASELINES_PATH}`);
      process.exit(1);
    }
    const loaded = (await file.json()) as Record<string, SizeBaseline>;
    for (const [name, entry] of Object.entries(loaded)) {
      if (
        typeof entry.min !== "number" ||
        typeof entry.max !== "number" ||
        typeof entry.description !== "string" ||
        entry.min < 0 ||
        entry.max < entry.min
      ) {
        error(
          `Invalid baseline entry '${name}': min=${entry.min}, max=${entry.max}, description=${JSON.stringify(entry.description)} — require 0 ≤ min ≤ max and description string`
        );
        process.exit(1);
      }
    }
    SIZE_BASELINES = loaded;
  } catch (err) {
    error(`Failed to load size baselines: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Print baseline information
 */
function showBaselines(): void {
  section("Extension Size Baselines");

  info("Known large extensions tracked for size regression:");
  console.log("");

  for (const [name, baseline] of Object.entries(SIZE_BASELINES)) {
    console.log(`  ${name}:`);
    console.log(`    Range: ${baseline.min.toFixed(2)}MB - ${baseline.max.toFixed(2)}MB`);
    console.log(`    Description: ${baseline.description}`);
    console.log("");
  }

  info(`Maximum allowed size increase: ${MAX_SIZE_INCREASE_PERCENT}% above baseline max`);
}

/**
 * Check if Docker image exists
 */
async function imageExists(imageName: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "images", "-q", imageName], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get .so file size from Docker image.
 * Returns size in MB, or null if the file is not found.
 */
async function getSoSize(imageName: string, extensionName: string): Promise<number | null> {
  try {
    // PostgreSQL extension libraries are always in $pkglibdir = /usr/lib/postgresql/N/lib/
    // /usr/share/ (FHS architecture-independent data) never contains .so files
    const pgVersion = Bun.env.PG_VERSION ?? "18";
    const soPath = `/usr/lib/postgresql/${pgVersion}/lib/${extensionName}.so`;
    const proc = Bun.spawn(["docker", "run", "--rm", imageName, "stat", "-c", "%s", soPath], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // Read stdout concurrently with exit — sequential reads risk deadlock
    const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (exitCode === 0) {
      const bytes = parseInt(output.trim(), 10);
      if (!isNaN(bytes)) {
        return bytes / (1024 * 1024); // Convert to MB
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure classification function — testable without Docker.
 *
 * @param extensionName  Extension name (for message formatting only)
 * @param size           Measured .so size in MB, or null if not found
 * @param baseline       Expected size range from size-baselines.json
 * @param maxIncreasePercent  Tolerance above baseline.max before failing (default: MAX_SIZE_INCREASE_PERCENT)
 */
export function classifySize(
  extensionName: string,
  size: number | null,
  baseline: SizeBaseline,
  maxIncreasePercent = MAX_SIZE_INCREASE_PERCENT
): SizeCheckResult {
  if (size === null) {
    return {
      passed: true,
      warn: true,
      category: "not-found",
      message: `${extensionName}: .so file not found in expected locations — broken build or non-standard path? Remove from size-baselines.json if intentional`,
    };
  }

  const maxAllowed = baseline.max * (1 + maxIncreasePercent / 100);

  if (size > maxAllowed) {
    return {
      passed: false,
      category: "exceeded",
      message: `${extensionName}: ${size.toFixed(2)}MB exceeds baseline max ${baseline.max.toFixed(2)}MB + ${maxIncreasePercent}% (${maxAllowed.toFixed(2)}MB)`,
    };
  } else if (size < baseline.min) {
    return {
      passed: true,
      warn: true,
      category: "below-min",
      message: `${extensionName}: ${size.toFixed(2)}MB (below baseline min ${baseline.min.toFixed(2)}MB — possible stripped or broken build; update baseline if intentional)`,
    };
  } else if (size <= baseline.max) {
    return {
      passed: true,
      category: "ok",
      message: `${extensionName}: ${size.toFixed(2)}MB (within expected range ${baseline.min.toFixed(2)}-${baseline.max.toFixed(2)}MB)`,
    };
  } else {
    // size > baseline.max but <= maxAllowed (within tolerance — advisory, not failure)
    return {
      passed: true,
      warn: true,
      category: "tolerance",
      message: `${extensionName}: ${size.toFixed(2)}MB (above baseline max ${baseline.max.toFixed(2)}MB but within ${maxIncreasePercent}% tolerance — update baseline if this is the new normal)`,
    };
  }
}

/**
 * Check size regression for an extension
 */
async function checkExtensionSize(
  imageName: string,
  extensionName: string,
  baseline: SizeBaseline
): Promise<SizeCheckResult> {
  const size = await getSoSize(imageName, extensionName);
  return classifySize(extensionName, size, baseline);
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
  if (!(await isDockerDaemonRunning())) {
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

  const results: SizeCheckResult[] = [];

  for (const extensionName of extensionsToCheck) {
    const baseline = SIZE_BASELINES[extensionName];
    if (!baseline) {
      continue; // Shouldn't happen, but satisfy TypeScript
    }
    const result = await checkExtensionSize(imageName, extensionName, baseline);
    results.push(result);

    if (!result.passed || result.warn) {
      warning(result.message);
    } else {
      success(result.message);
    }
  }

  console.log("");

  // Use category discriminator for accurate summary messages
  const exceeded = results.filter((r) => r.category === "exceeded");
  const notFound = results.filter((r) => r.category === "not-found");
  const belowMin = results.filter((r) => r.category === "below-min");
  const tolerance = results.filter((r) => r.category === "tolerance");

  if (exceeded.length > 0) {
    warning(
      `${exceeded.length} extension(s) exceeded size baselines (non-critical - review changes)`
    );
    info("This may indicate:");
    info("  - Dependency updates that increased binary size");
    info("  - New features or functionality added");
    info("  - Build configuration changes");
    info("  - Update scripts/config/size-baselines.json if intentional");
  }
  if (notFound.length > 0) {
    warning(
      `${notFound.length} extension(s): .so file not found — check build completeness or update size-baselines.json`
    );
  }
  if (belowMin.length > 0) {
    warning(
      `${belowMin.length} extension(s) below baseline min — possible stripped or broken build; update size-baselines.json if intentional`
    );
  }
  if (tolerance.length > 0) {
    warning(
      `${tolerance.length} extension(s) above baseline max but within tolerance — update size-baselines.json if this is the new normal`
    );
  }
  if (
    exceeded.length === 0 &&
    notFound.length === 0 &&
    belowMin.length === 0 &&
    tolerance.length === 0
  ) {
    success("All extension sizes within expected ranges!");
  }

  // Note: This is a non-critical check, so we don't exit with error
}

// import.meta.main guard: allows classifySize to be imported for unit tests
// without triggering Docker operations or process.exit() calls
if (import.meta.main) {
  main().catch((err) => {
    error(`Size regression check error: ${getErrorMessage(err)}`);
    process.exit(1);
  });
}
