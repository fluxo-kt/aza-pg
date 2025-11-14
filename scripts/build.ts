#!/usr/bin/env bun
//
// Build PostgreSQL image (canonical build script)
// Uses Docker Buildx with intelligent caching for fast builds
//
// Usage:
//   bun scripts/build.ts                 # Single-platform (current arch)
//   bun scripts/build.ts --multi-arch    # Multi-platform (amd64 + arm64)
//   bun scripts/build.ts --push          # Build and push to registry
//
// Requirements:
//   - Docker Buildx installed (bundled with Docker Desktop / Docker 19.03+)
//   - Network access to ghcr.io for cache pull
//   - ghcr.io write access for --push (requires docker login ghcr.io)
//
// Performance:
//   - First build: ~12min (compiles all extensions)
//   - Cached build: ~2min (reuses CI artifacts)
//   - No network: ~12min (falls back to local cache)
//

import { $ } from "bun";

// Configuration interface
interface BuildConfig {
  builderName: string;
  imageName: string;
  imageTag: string;
  cacheRegistry: string;
  cacheTag: string;
  multiArch: boolean;
  push: boolean;
  load: boolean;
}

// Parse command line arguments
function parseArgs(): BuildConfig {
  const config: BuildConfig = {
    builderName: "aza-pg-builder",
    imageName: Bun.env.POSTGRES_IMAGE || "aza-pg",
    imageTag: Bun.env.POSTGRES_TAG || "pg18",
    cacheRegistry: "ghcr.io/fluxo-kt/aza-pg",
    cacheTag: "buildcache",
    multiArch: false,
    push: false,
    load: true,
  };

  const args = Bun.argv.slice(2);

  for (const arg of args) {
    switch (arg) {
      case "--multi-arch":
        config.multiArch = true;
        config.load = false; // Multi-arch builds cannot load, must push
        break;
      case "--push":
        config.push = true;
        config.load = false;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        console.error("Run with --help for usage");
        process.exit(1);
    }
  }

  return config;
}

// Print help text
function printHelp(): void {
  const helpText = `
Build PostgreSQL image (canonical build script)
Uses Docker Buildx with intelligent caching for fast builds

Usage:
  bun scripts/build.ts                 # Single-platform (current arch)
  bun scripts/build.ts --multi-arch    # Multi-platform (amd64 + arm64)
  bun scripts/build.ts --push          # Build and push to registry

Requirements:
  - Docker Buildx installed (bundled with Docker Desktop / Docker 19.03+)
  - Network access to ghcr.io for cache pull
  - ghcr.io write access for --push (requires docker login ghcr.io)

Performance:
  - First build: ~12min (compiles all extensions)
  - Cached build: ~2min (reuses CI artifacts)
  - No network: ~12min (falls back to local cache)
`.trim();
  console.log(helpText);
}

// Validate extensions manifest
async function validateManifest(): Promise<void> {
  console.log("Validating extensions manifest...");
  try {
    const result = await $`bun run scripts/extensions/validate-manifest.ts`.quiet();
    if (result.exitCode !== 0) {
      throw new Error("Manifest validation failed");
    }
  } catch {
    console.error("ERROR: Manifest validation failed");
    process.exit(1);
  }
  console.log("");
}

// Check Dockerfile with hadolint
async function checkHadolint(): Promise<void> {
  console.log("Checking Dockerfile with hadolint...");

  // Check if hadolint is available
  try {
    await $`which hadolint`.quiet();
  } catch {
    console.log("WARNING: hadolint not found, skipping Dockerfile lint");
    console.log("Install hadolint for Dockerfile validation:");
    console.log("  brew install hadolint  (macOS)");
    console.log("  or visit: https://github.com/hadolint/hadolint");
    console.log("");
    return;
  }

  // Run hadolint on the Dockerfile
  try {
    const result = await $`hadolint docker/postgres/Dockerfile`.quiet();
    if (result.exitCode !== 0) {
      console.error("ERROR: hadolint found issues in Dockerfile");
      console.error("");
      // Show the actual hadolint output
      const output = await $`hadolint docker/postgres/Dockerfile`.text();
      console.error(output);
      console.error("Fix the Dockerfile issues before building");
      process.exit(1);
    }
    console.log("Dockerfile passed hadolint validation");
  } catch (err) {
    console.error("ERROR: hadolint validation failed");
    console.error(String(err));
    process.exit(1);
  }
  console.log("");
}

// Check if logged into Docker registry
async function checkDockerLogin(config: BuildConfig): Promise<void> {
  if (config.push || config.multiArch) {
    try {
      const result = await $`docker info`.text();
      if (!result.includes("Username:")) {
        console.error("ERROR: Not logged into container registry");
        console.error("Run: docker login ghcr.io");
        process.exit(1);
      }
    } catch {
      console.error("ERROR: Failed to check Docker login status");
      process.exit(1);
    }
  }
}

// Set up or reuse buildx builder
async function setupBuilder(builderName: string): Promise<void> {
  try {
    // Check if builder exists
    await $`docker buildx inspect ${builderName}`.quiet();
    console.log(`Using existing buildx builder: ${builderName}`);
    await $`docker buildx use ${builderName}`.quiet();
  } catch {
    // Builder doesn't exist, create it
    console.log(`Creating buildx builder: ${builderName}`);
    await $`docker buildx create --name ${builderName} --driver docker-container --driver-opt network=host --use`.quiet();
  }
}

// Determine build platforms based on current architecture
function determinePlatforms(multiArch: boolean): string {
  if (multiArch) {
    console.log("Building multi-platform: linux/amd64,linux/arm64");
    return "linux/amd64,linux/arm64";
  }

  // Single platform (current architecture)
  const arch = process.arch;
  let platform: string;

  switch (arch) {
    case "x64":
      platform = "linux/amd64";
      break;
    case "arm64":
      platform = "linux/arm64";
      break;
    default:
      console.error(`ERROR: Unsupported architecture: ${arch}`);
      process.exit(1);
  }

  console.log(`Building single-platform: ${platform}`);
  return platform;
}

// Build the Docker image
async function buildImage(config: BuildConfig): Promise<void> {
  const platforms = determinePlatforms(config.multiArch);

  // Build arguments array
  const buildArgs: string[] = [
    "buildx",
    "build",
    "--builder",
    config.builderName,
    "--platform",
    platforms,
    "--file",
    "docker/postgres/Dockerfile",
    "--tag",
    `${config.imageName}:${config.imageTag}`,
  ];

  // Cache configuration (remote + local fallback)
  buildArgs.push(
    "--cache-from",
    `type=registry,ref=${config.cacheRegistry}:${config.cacheTag}`,
    "--cache-from",
    "type=local,src=/tmp/.buildx-cache",
    "--cache-to",
    "type=local,dest=/tmp/.buildx-cache,mode=max"
  );

  // Load or push
  if (config.push) {
    buildArgs.push("--push");
    buildArgs.push(
      "--cache-to",
      `type=registry,ref=${config.cacheRegistry}:${config.cacheTag},mode=max`
    );
    console.log(`Will push to registry: ${config.imageName}:${config.imageTag}`);
  } else if (config.load) {
    buildArgs.push("--load");
    console.log("Will load to local Docker daemon");
  } else {
    // Multi-arch without push (dry-run)
    console.log("Multi-arch build (will not load to local daemon)");
  }

  // Build metadata
  buildArgs.push(
    "--provenance",
    "false", // Disable for local builds (CI enables)
    "--sbom",
    "false" // Disable for local builds (CI enables)
  );

  // Current context
  buildArgs.push(".");

  // Print command for transparency
  console.log("");
  console.log("Running buildx command:");
  console.log("docker \\");
  for (let i = 0; i < buildArgs.length; i++) {
    const arg = buildArgs[i];
    const prefix = i === 0 ? "  " : "  ";
    const suffix = i === buildArgs.length - 1 ? "" : " \\";
    console.log(`${prefix}${arg}${suffix}`);
  }
  console.log("");

  // Execute build with timing
  const startTime = Date.now();

  try {
    await $`docker ${buildArgs}`;
  } catch {
    console.error("\nBUILD FAILED");
    process.exit(1);
  }

  const endTime = Date.now();
  const duration = Math.round((endTime - startTime) / 1000);

  // Print summary
  console.log("");
  console.log("================================================================");
  console.log("BUILD COMPLETE");
  console.log("================================================================");
  console.log(`Duration: ${duration}s`);
  console.log(`Image: ${config.imageName}:${config.imageTag}`);
  console.log(`Platforms: ${platforms}`);

  if (config.push) {
    console.log("Status: Pushed to registry");
  } else if (config.load) {
    console.log("Status: Loaded to local Docker daemon");
  } else {
    console.log("Status: Built (not loaded to daemon)");
  }

  console.log("");
  console.log("Test the image:");
  console.log(`  docker run --rm ${config.imageName}:${config.imageTag} psql --version`);
  console.log("");
  console.log("Deploy with compose:");
  console.log("  cd stacks/primary");
  console.log(`  POSTGRES_IMAGE=${config.imageName}:${config.imageTag} docker compose up -d`);
  console.log("================================================================");
}

// Main execution
async function main(): Promise<void> {
  const config = parseArgs();

  await validateManifest();
  await checkHadolint();
  await checkDockerLogin(config);
  await setupBuilder(config.builderName);
  await buildImage(config);
}

// Run main and handle errors
main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
