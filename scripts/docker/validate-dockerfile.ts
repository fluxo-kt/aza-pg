#!/usr/bin/env bun
/**
 * Validate that Dockerfile is up-to-date with template and manifest
 *
 * This script checks if the generated Dockerfile matches what would be
 * generated from the current template and manifest. Used in CI/pre-commit
 * to ensure developers don't forget to regenerate.
 *
 * Usage:
 *   bun scripts/docker/validate-dockerfile.ts        # Check if Dockerfile is up-to-date
 *   bun scripts/docker/validate-dockerfile.ts --fix  # Regenerate if out of date
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { error, info, section, success, warning } from "../utils/logger.js";

// Paths
const REPO_ROOT = join(import.meta.dir, "../..");
const DOCKERFILE_PATH = join(REPO_ROOT, "docker/postgres/Dockerfile");
const TEMPLATE_PATH = join(REPO_ROOT, "docker/postgres/Dockerfile.template");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");
const GENERATOR_SCRIPT = join(REPO_ROOT, "scripts/docker/generate-dockerfile.ts");

/**
 * Check if required files exist
 */
function checkFilesExist(): boolean {
  const files = [
    { path: TEMPLATE_PATH, name: "Dockerfile.template" },
    { path: MANIFEST_PATH, name: "extensions.manifest.json" },
    { path: GENERATOR_SCRIPT, name: "generate-dockerfile.ts" },
  ];

  let allExist = true;
  for (const file of files) {
    if (!existsSync(file.path)) {
      error(`Missing required file: ${file.name}`);
      allExist = false;
    }
  }

  return allExist;
}

/**
 * Generate Dockerfile to temporary location and compare
 */
async function validateDockerfile(): Promise<boolean> {
  section("Dockerfile Validation");

  // Check required files
  if (!checkFilesExist()) {
    error("Required files missing");
    return false;
  }

  // Check if Dockerfile exists
  if (!existsSync(DOCKERFILE_PATH)) {
    warning("Dockerfile does not exist - needs to be generated");
    return false;
  }

  // Read current Dockerfile
  info("Reading current Dockerfile...");
  const currentDockerfile = await Bun.file(DOCKERFILE_PATH).text();

  // Generate new Dockerfile to temp file
  info("Generating Dockerfile from template...");
  const tempPath = join(REPO_ROOT, "docker/postgres/Dockerfile.tmp");

  // Temporarily rename current Dockerfile
  await Bun.write(tempPath, currentDockerfile);

  // Run generator
  const result = spawnSync("bun", [GENERATOR_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    error("Failed to generate Dockerfile");
    console.error(result.stderr);
    // Restore original
    await Bun.write(DOCKERFILE_PATH, currentDockerfile);
    return false;
  }

  // Read newly generated Dockerfile
  const generatedDockerfile = await Bun.file(DOCKERFILE_PATH).text();

  // Restore original for comparison
  await Bun.write(DOCKERFILE_PATH, currentDockerfile);

  // Compare (ignoring timestamp in header)
  const normalizedCurrent = normalizeDockerfile(currentDockerfile);
  const normalizedGenerated = normalizeDockerfile(generatedDockerfile);

  if (normalizedCurrent === normalizedGenerated) {
    success("Dockerfile is up-to-date!");
    return true;
  } else {
    error("Dockerfile is out of date!");
    warning("Run 'bun run generate' to regenerate Dockerfile");

    // Show diff hint
    await Bun.write(tempPath, generatedDockerfile);
    warning(`Temporary generated file at: ${tempPath}`);
    warning(`Compare with: diff ${DOCKERFILE_PATH} ${tempPath}`);

    return false;
  }
}

/**
 * Normalize Dockerfile content for comparison
 * Removes generation timestamp to avoid false positives
 */
function normalizeDockerfile(content: string): string {
  // Remove AUTO-GENERATED header (first 6 lines)
  const lines = content.split("\n");
  const withoutHeader = lines.slice(6).join("\n");

  // Normalize whitespace
  return withoutHeader.trim();
}

/**
 * Regenerate Dockerfile if out of date
 */
async function fixDockerfile(): Promise<boolean> {
  info("Regenerating Dockerfile...");

  const result = spawnSync("bun", [GENERATOR_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    error("Failed to regenerate Dockerfile");
    return false;
  }

  success("Dockerfile regenerated successfully!");
  return true;
}

/**
 * Main validation function
 */
async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const shouldFix = args.includes("--fix");

  const isValid = await validateDockerfile();

  if (!isValid) {
    if (shouldFix) {
      const fixed = await fixDockerfile();
      if (!fixed) {
        process.exit(1);
      }
    } else {
      process.exit(1);
    }
  }
}

// Main execution
if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    error(`Validation error: ${String(err)}`);
    process.exit(1);
  }
}
