/**
 * Docker Test Configuration Utility
 *
 * Provides isolated Docker configuration for tests that don't require credential helpers.
 * Automatically detects if Docker credential helper is available and creates isolated
 * config if needed to avoid "docker-credential-osxkeychain not found" errors.
 *
 * Usage:
 *   import { getTestDockerConfig } from "../utils/docker-test-config";
 *
 *   const testDockerConfig = await getTestDockerConfig();
 *   const dockerEnv = testDockerConfig
 *     ? { ...Bun.env, DOCKER_CONFIG: testDockerConfig }
 *     : Bun.env;
 *
 *   await $`docker compose up -d`.env(dockerEnv);
 */

import { mkdir } from "node:fs/promises";
import { warning } from "./logger";

/**
 * Check if Docker credential helper is available in PATH.
 * Tests for common credential helpers: osxkeychain, pass, secretservice, wincred.
 *
 * @returns True if any credential helper is available, false otherwise
 */
export function hasCredentialHelper(): boolean {
  const helpers = [
    "docker-credential-osxkeychain", // macOS
    "docker-credential-pass", // Linux (pass)
    "docker-credential-secretservice", // Linux (GNOME Keyring)
    "docker-credential-wincred", // Windows
  ];

  for (const helper of helpers) {
    try {
      const result = Bun.spawnSync([helper, "version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (result.exitCode === 0) {
        return true;
      }
    } catch {
      // Helper not found, continue checking
    }
  }

  return false;
}

/**
 * Create isolated Docker config directory for tests.
 * Config excludes credential helper requirements to avoid PATH issues.
 *
 * @returns Path to temporary Docker config directory
 */
export async function createTestDockerConfig(): Promise<string> {
  const tmpDir = `/tmp/docker-test-config-${Date.now()}-${process.pid}`;
  await mkdir(tmpDir, { recursive: true });

  // Create minimal Docker config without credential helper
  const config = {
    auths: {
      "ghcr.io": {},
    },
  };

  await Bun.write(`${tmpDir}/config.json`, JSON.stringify(config, null, 2));
  return tmpDir;
}

/**
 * Get Docker config path for tests.
 * Returns isolated config if credential helper unavailable, undefined to use system config otherwise.
 *
 * This function is idempotent and can be called multiple times safely.
 *
 * @returns Docker config directory path or undefined for system config
 */
export async function getTestDockerConfig(): Promise<string | undefined> {
  if (hasCredentialHelper()) {
    // System config is usable, no isolation needed
    return undefined;
  }

  warning("Docker credential helper not available, using isolated test config");
  return await createTestDockerConfig();
}

/**
 * Clean up isolated Docker config directory if created.
 * Safe to call even if no isolated config was created.
 *
 * @param configPath - Path returned by getTestDockerConfig()
 */
export async function cleanupTestDockerConfig(configPath: string | undefined): Promise<void> {
  if (!configPath) {
    return; // No isolated config to cleanup
  }

  try {
    // Remove isolated config directory
    const result = Bun.spawnSync(["rm", "-rf", configPath], {
      stdout: "ignore",
      stderr: "ignore",
    });

    if (result.exitCode !== 0) {
      warning(`Failed to cleanup Docker test config: ${configPath}`);
    }
  } catch (err) {
    warning(
      `Error during Docker test config cleanup: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
