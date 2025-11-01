#!/usr/bin/env bun
/**
 * Test script: Build Docker image and verify extensions
 * Usage: bun run scripts/test/test-build.ts [image-tag]
 *
 * Examples:
 *   bun run scripts/test/test-build.ts                    # Use default tag 'ghcr.io/fluxo-kt/aza-pg:pg18'
 *   bun run scripts/test/test-build.ts my-custom:tag      # Use custom tag
 */

import { $ } from "bun";
import { resolve, dirname } from "node:path";
import { checkCommand, checkDockerDaemon, dockerCleanup, waitForPostgres } from "../utils/docker";
import { error } from "../utils/logger";

/**
 * Build test configuration
 */
interface BuildTestConfig {
  imageTag: string;
  projectRoot: string;
  testPassword: string;
  containerName: string;
}

/**
 * Extension test definition
 */
interface ExtensionTest {
  name: string;
  functionalityTest?: {
    description: string;
    sql: string;
  };
}

/**
 * Generate random test password at runtime
 */
function generateTestPassword(): string {
  const envPassword = Bun.env.TEST_PASSWORD;
  if (envPassword) {
    return envPassword;
  }
  const timestamp = Date.now();
  const pid = process.pid;
  return `test_postgres_${timestamp}_${pid}`;
}

/**
 * Get project root directory
 */
function getProjectRoot(): string {
  const scriptDir = dirname(import.meta.dir);
  return resolve(scriptDir, "..");
}

/**
 * Check prerequisites for building and testing
 */
async function checkPrerequisites(): Promise<void> {
  try {
    await checkCommand("docker");
  } catch (err) {
    error((err as Error).message);
    console.log("   Install Docker: https://docs.docker.com/get-docker/");
    process.exit(1);
  }

  try {
    await checkDockerDaemon();
  } catch (err) {
    error((err as Error).message);
    console.log("   Start Docker: open -a Docker (macOS) or sudo systemctl start docker (Linux)");
    process.exit(1);
  }
}

/**
 * Verify Dockerfile exists
 */
function verifyDockerfile(projectRoot: string): void {
  const dockerfilePath = resolve(projectRoot, "docker/postgres/Dockerfile");
  if (!Bun.file(dockerfilePath).size) {
    error(`Dockerfile not found at: ${dockerfilePath}`);
    console.log(`   Check project structure: ls -la ${resolve(projectRoot, "docker/postgres/")}`);
    process.exit(1);
  }
}

/**
 * Build Docker image using buildx
 */
async function buildDockerImage(config: BuildTestConfig): Promise<void> {
  console.log("📦 Building Docker image with buildx...");
  const dockerfilePath = "docker/postgres/Dockerfile";

  try {
    await $`cd ${config.projectRoot} && docker buildx build --load -f ${dockerfilePath} -t ${config.imageTag} .`;
    console.log("✅ Build successful");
    console.log();
  } catch {
    console.log();
    error("Docker buildx build failed");
    console.log("   Check Dockerfile syntax and build context");
    console.log(
      `   Retry with verbose output: docker buildx build --load --progress=plain -f ${dockerfilePath} -t ${config.imageTag} .`
    );
    process.exit(1);
  }
}

/**
 * Verify PostgreSQL version in built image
 */
async function verifyPostgresVersion(imageTag: string): Promise<void> {
  console.log("🔍 Verifying PostgreSQL version...");
  try {
    const result = await $`docker run --rm ${imageTag} psql --version`.text();
    console.log(result.trim());
    console.log();
  } catch {
    error("Failed to verify PostgreSQL version");
    console.log(`   Image may be corrupted: docker images ${imageTag}`);
    process.exit(1);
  }
}

/**
 * Verify entrypoint exists in image
 */
async function verifyEntrypoint(imageTag: string): Promise<void> {
  console.log("🔍 Checking auto-config entrypoint...");
  try {
    await $`docker run --rm ${imageTag} ls -la /usr/local/bin/docker-auto-config-entrypoint.sh`;
    console.log();
  } catch {
    error("Auto-config entrypoint not found in image");
    console.log("   Check Dockerfile COPY instructions");
    process.exit(1);
  }
}

/**
 * Start test container
 */
async function startTestContainer(config: BuildTestConfig): Promise<void> {
  console.log("🚀 Starting test container...");
  try {
    await $`docker run -d --name ${config.containerName} -e POSTGRES_PASSWORD=${config.testPassword} ${config.imageTag}`.quiet();
  } catch {
    error("Failed to start test container");
    console.log(`   Check Docker logs: docker logs ${config.containerName}`);
    process.exit(1);
  }
}

/**
 * Wait for PostgreSQL to be ready and show auto-config logs
 */
async function waitForPostgresReady(config: BuildTestConfig): Promise<void> {
  try {
    await waitForPostgres({
      host: "localhost",
      port: 5432,
      user: "postgres",
      timeout: 60,
      container: config.containerName,
    });
    console.log();
  } catch {
    console.log();
    console.log("Container logs:");
    try {
      await $`docker logs ${config.containerName}`;
    } catch {
      // Ignore error if can't get logs
    }
    process.exit(1);
  }

  // Show auto-config logs
  console.log("📋 Auto-config detection logs:");
  try {
    const logs = await $`docker logs ${config.containerName} 2>&1`.text();
    const autoConfigLogs = logs
      .split("\n")
      .filter((line) => line.includes("[AUTO-CONFIG]"))
      .join("\n");
    if (autoConfigLogs) {
      console.log(autoConfigLogs);
    } else {
      console.log("No auto-config logs found");
    }
  } catch {
    console.log("No auto-config logs found");
  }
  console.log();
}

/**
 * Create extension in database
 */
async function createExtension(config: BuildTestConfig, extensionName: string): Promise<boolean> {
  const sql = `CREATE EXTENSION IF NOT EXISTS "${extensionName}";`;
  try {
    await $`docker exec -e PGPASSWORD=${config.testPassword} ${config.containerName} psql -U postgres -c ${sql}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Test creating extensions
 */
async function testExtensionCreation(config: BuildTestConfig): Promise<void> {
  console.log("🧪 Testing extensions...");
  const extensions = [
    "vector",
    "pg_trgm",
    "pg_cron",
    "pgaudit",
    "pg_stat_statements",
    "btree_gin",
    "btree_gist",
  ];

  console.log("Creating extensions...");
  const failedExtensions: string[] = [];

  for (const ext of extensions) {
    process.stdout.write(`  - ${ext}: `);
    const success = await createExtension(config, ext);
    if (success) {
      console.log("✅");
    } else {
      console.log("❌ FAILED");
      failedExtensions.push(ext);
    }
  }

  if (failedExtensions.length > 0) {
    console.log();
    error(`Failed to create extensions: ${failedExtensions.join(", ")}`);
    console.log("   Check container logs for compilation errors:");
    console.log(`   docker logs ${config.containerName} | grep -i error`);
    process.exit(1);
  }
  console.log();
}

/**
 * Run a SQL query and verify it succeeds
 */
async function runSqlTest(config: BuildTestConfig, sql: string): Promise<boolean> {
  try {
    await $`docker exec -e PGPASSWORD=${config.testPassword} ${config.containerName} psql -U postgres -c ${sql}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify extension functionality with specific tests
 */
async function verifyExtensionFunctionality(config: BuildTestConfig): Promise<void> {
  console.log("🔬 Verifying extension functionality...");

  const functionalityTests: ExtensionTest[] = [
    {
      name: "pgvector (vector type)",
      functionalityTest: {
        description: "pgvector (vector type)",
        sql: "SELECT '[1,2,3]'::vector;",
      },
    },
    {
      name: "pg_trgm (similarity)",
      functionalityTest: {
        description: "pg_trgm (similarity)",
        sql: "SELECT similarity('test', 'test');",
      },
    },
    {
      name: "pg_stat_statements (view)",
      functionalityTest: {
        description: "pg_stat_statements (view)",
        sql: "SELECT COUNT(*) FROM pg_stat_statements;",
      },
    },
    {
      name: "pg_cron (cron.job table)",
      functionalityTest: {
        description: "pg_cron (cron.job table)",
        sql: "SELECT COUNT(*) FROM cron.job;",
      },
    },
  ];

  for (const test of functionalityTests) {
    if (!test.functionalityTest) continue;

    process.stdout.write(`  - ${test.functionalityTest.description}: `);
    const success = await runSqlTest(config, test.functionalityTest.sql);
    if (success) {
      console.log("✅");
    } else {
      console.log("❌ FAILED");
      process.exit(1);
    }
  }

  console.log();
}

/**
 * List all installed extensions
 */
async function listInstalledExtensions(config: BuildTestConfig): Promise<void> {
  console.log("📦 Installed extensions:");
  try {
    const result =
      await $`docker exec -e PGPASSWORD=${config.testPassword} ${config.containerName} psql -U postgres -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"`.text();
    const lines = result
      .split("\n")
      .filter((line) => !line.includes("row"))
      .join("\n");
    console.log(lines);
  } catch {
    error("Failed to list installed extensions");
  }
  console.log();
}

/**
 * Main test execution
 */
async function main(): Promise<void> {
  // Parse arguments
  const imageTag = Bun.argv[2] ?? "ghcr.io/fluxo-kt/aza-pg:pg18";
  const projectRoot = getProjectRoot();
  const testPassword = generateTestPassword();
  const containerName = `pg-test-${process.pid}`;

  const config: BuildTestConfig = {
    imageTag,
    projectRoot,
    testPassword,
    containerName,
  };

  // Print header
  console.log("========================================");
  console.log("PostgreSQL Image Build & Extension Test");
  console.log("========================================");
  console.log(`Image tag: ${config.imageTag}`);
  console.log(`Project root: ${config.projectRoot}`);
  console.log();

  // Setup cleanup handler
  let cleanupRegistered = false;
  const cleanup = async () => {
    if (cleanupRegistered) {
      console.log();
      console.log("🧹 Cleaning up...");
      await dockerCleanup(config.containerName);
    }
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(143);
  });

  try {
    // Check prerequisites
    await checkPrerequisites();

    // Verify Dockerfile exists
    verifyDockerfile(config.projectRoot);

    // Build image
    await buildDockerImage(config);

    // Verify Postgres version
    await verifyPostgresVersion(config.imageTag);

    // Verify entrypoint
    await verifyEntrypoint(config.imageTag);

    // Start test container
    await startTestContainer(config);
    cleanupRegistered = true; // Enable cleanup after container is started

    // Wait for PostgreSQL to be ready
    await waitForPostgresReady(config);

    // Test extension creation
    await testExtensionCreation(config);

    // Verify extension functionality
    await verifyExtensionFunctionality(config);

    // List installed extensions
    await listInstalledExtensions(config);

    // Success
    console.log("========================================");
    console.log("✅ All tests passed!");
    console.log(`Image: ${config.imageTag}`);
    console.log("========================================");

    // Cleanup
    await cleanup();
    process.exit(0);
  } catch (err) {
    await cleanup();
    error((err as Error).message);
    process.exit(1);
  }
}

// Run main function
main();
