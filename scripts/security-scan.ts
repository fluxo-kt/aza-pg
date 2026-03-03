#!/usr/bin/env bun
/**
 * Local Security Scan
 *
 * Runs Trivy against a locally built image using the Docker container approach —
 * no binary download, no GitHub release dependency (resilient to supply-chain attacks
 * like the Trivy security incident 2026-03-01 that deleted release assets v0.27-v0.69.1).
 *
 * Usage:
 *   bun scripts/security-scan.ts [IMAGE_REF]
 *   bun run security:scan
 *   bun run security:scan -- ghcr.io/fluxo-kt/aza-pg-testing@sha256:abc123
 *
 * Defaults to the local build image: aza-pg:pg18
 * To build first: bun run build
 */

import { isDockerDaemonRunning } from "./utils/docker";
import { error, info, section, success } from "./utils/logger";
import { getErrorMessage } from "./utils/errors";
import { join } from "node:path";

// Pinned to a version with immutable releases (post-incident v0.69.3+)
const TRIVY_IMAGE = "aquasec/trivy:0.69.3";
const DEFAULT_IMAGE = "aza-pg:pg18";

const PROJECT_ROOT = join(import.meta.dir, "..");

async function pullTrivyIfNeeded(): Promise<boolean> {
  info(`Ensuring Trivy image is available: ${TRIVY_IMAGE}`);

  const checkProc = Bun.spawn(["docker", "image", "inspect", TRIVY_IMAGE], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const checkExit = await checkProc.exited;

  if (checkExit === 0) {
    return true; // Already cached locally
  }

  info(`Pulling ${TRIVY_IMAGE}...`);
  const pullProc = Bun.spawn(["docker", "pull", TRIVY_IMAGE], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const pullExit = await pullProc.exited;

  if (pullExit !== 0) {
    error(`Failed to pull Trivy image: ${TRIVY_IMAGE}`);
    return false;
  }

  return true;
}

async function runScan(imageRef: string): Promise<boolean> {
  section("Security Scan (Trivy)");
  info(`Target: ${imageRef}`);
  console.log("");

  // Use Docker container to run Trivy — avoids GitHub release binary download entirely
  // The trivy DB cache dir is mounted from the project to reuse across runs
  const cacheDir = join(PROJECT_ROOT, ".trivy-cache");
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-v",
      `${cacheDir}:/root/.cache/trivy`,
      // Mount Docker socket so Trivy can inspect local images
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      TRIVY_IMAGE,
      "image",
      "--severity",
      "CRITICAL,HIGH",
      "--format",
      "table",
      "--exit-code",
      "1",
      imageRef,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function main(): Promise<void> {
  const imageRef = Bun.argv[2] ?? DEFAULT_IMAGE;

  if (!(await isDockerDaemonRunning())) {
    error("Docker daemon is not running. Start Docker and try again.");
    process.exit(1);
  }

  const trivyAvailable = await pullTrivyIfNeeded();
  if (!trivyAvailable) {
    error(`Cannot pull Trivy image (${TRIVY_IMAGE}). Check network and Docker Hub access.`);
    process.exit(1);
  }

  const clean = await runScan(imageRef);

  console.log("");
  if (clean) {
    success("No CRITICAL or HIGH vulnerabilities found.");
  } else {
    error("CRITICAL or HIGH vulnerabilities detected. Review output above.");
    process.exit(1);
  }
}

main().catch((err) => {
  error(`Security scan failed: ${getErrorMessage(err)}`);
  process.exit(1);
});
