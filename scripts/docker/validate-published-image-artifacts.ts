#!/usr/bin/env bun

/**
 * Validate Published Docker Image Artifacts
 *
 * Validates Docker image artifacts without starting a container:
 * - Image existence and digest
 * - OCI metadata annotations
 * - Image configuration (ports, user, workdir, entrypoint)
 * - Layer structure and count
 * - Architecture and platform
 * - Image size (both uncompressed and compressed/wire size)
 *
 * Usage:
 *   bun scripts/docker/validate-published-image-artifacts.ts [IMAGE_TAG]
 *   POSTGRES_IMAGE=aza-pg:local bun scripts/docker/validate-published-image-artifacts.ts
 *
 * Examples:
 *   # Validate remote image
 *   bun scripts/docker/validate-published-image-artifacts.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511230033-single-node
 *
 *   # Validate local image via environment variable
 *   POSTGRES_IMAGE=aza-pg:pg18 bun scripts/docker/validate-published-image-artifacts.ts
 *
 *   # Validate with image flag
 *   bun scripts/docker/validate-published-image-artifacts.ts --image=aza-pg:pg18
 *
 * Exit Codes:
 *   0 - All critical checks passed
 *   1 - Critical validation failures
 */

import { $ } from "bun";
import { resolveImageWithSource } from "../test/image-resolver";
import { success, error, warning, info, section, separator } from "../utils/logger";
import { getErrorMessage } from "../utils/errors";
import { type ImageData, formatSize, inspectImage, getCompressedSize } from "./image-metrics";

interface ValidationResult {
  name: string;
  passed: boolean;
  critical: boolean;
  message?: string;
}

const REQUIRED_OCI_LABELS = [
  "org.opencontainers.image.version",
  "org.opencontainers.image.created",
  "org.opencontainers.image.revision",
  "org.opencontainers.image.source",
];

const RECOMMENDED_OCI_LABELS = [
  "org.opencontainers.image.base.name",
  "org.opencontainers.image.base.digest",
];

function printHelp(): void {
  const helpText = `
Validate Published Docker Image Artifacts

Validates Docker image artifacts without starting a container:
- Image existence and digest
- OCI metadata annotations
- Image configuration (ports, user, workdir, entrypoint)
- Layer structure and count
- Architecture and platform
- Image size

Usage:
  bun scripts/docker/validate-published-image-artifacts.ts [IMAGE_TAG]
  POSTGRES_IMAGE=IMAGE bun scripts/docker/validate-published-image-artifacts.ts

Examples:
  # Validate remote image
  bun scripts/docker/validate-published-image-artifacts.ts ghcr.io/fluxo-kt/aza-pg:18.1-202511230033-single-node

  # Validate local image via environment variable
  POSTGRES_IMAGE=aza-pg:pg18 bun scripts/docker/validate-published-image-artifacts.ts

  # Validate with image flag
  bun scripts/docker/validate-published-image-artifacts.ts --image=aza-pg:pg18

Exit Codes:
  0 - All critical checks passed
  1 - Critical validation failures
`;
  console.log(helpText.trim());
}

function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toISOString();
  } catch {
    return timestamp;
  }
}

async function checkDockerAvailable(): Promise<void> {
  try {
    const result = await $`docker --version`.nothrow();
    if (result.exitCode !== 0) {
      error("Docker is not available or not running");
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check Docker availability: ${getErrorMessage(err)}`);
    process.exit(1);
  }
}

function validateImageExists(imageData: ImageData | null, imageTag: string): ValidationResult {
  if (!imageData) {
    return {
      name: "Image Exists",
      passed: false,
      critical: true,
      message: `Image not found: ${imageTag}`,
    };
  }

  return {
    name: "Image Exists",
    passed: true,
    critical: true,
  };
}

function validateDigest(imageData: ImageData): ValidationResult {
  const digests = imageData.RepoDigests || [];

  if (digests.length === 0) {
    return {
      name: "Image Digest",
      passed: true,
      critical: false,
      message: "No digest found (local image or not pushed)",
    };
  }

  const digest = digests[0]?.split("@")[1];
  if (!digest || !digest.startsWith("sha256:")) {
    return {
      name: "Image Digest",
      passed: false,
      critical: false,
      message: "Invalid digest format",
    };
  }

  return {
    name: "Image Digest",
    passed: true,
    critical: false,
    message: digest,
  };
}

function validateImageSize(imageData: ImageData): ValidationResult {
  const size = imageData.Size;
  const sizeGB = size / (1024 * 1024 * 1024);

  if (sizeGB > 2) {
    return {
      name: "Image Size (Uncompressed)",
      passed: true,
      critical: false,
      message: `${formatSize(size)} (warning: exceeds 2GB)`,
    };
  }

  return {
    name: "Image Size (Uncompressed)",
    passed: true,
    critical: false,
    message: formatSize(size),
  };
}

async function validateCompressedSize(
  imageTag: string,
  imageData: ImageData
): Promise<ValidationResult> {
  try {
    const compressedSize = await getCompressedSize(imageTag, imageData);

    if (compressedSize === null) {
      return {
        name: "Image Size (Compressed)",
        passed: true,
        critical: false,
        message: "Not available (local image without digest)",
      };
    }

    return {
      name: "Image Size (Compressed)",
      passed: true,
      critical: false,
      message: `${formatSize(compressedSize)} (wire size)`,
    };
  } catch (err) {
    return {
      name: "Image Size (Compressed)",
      passed: true,
      critical: false,
      message: `Error calculating: ${getErrorMessage(err)}`,
    };
  }
}

function validateOciLabels(imageData: ImageData): ValidationResult[] {
  const labels = imageData.Config.Labels || {};
  const results: ValidationResult[] = [];

  // Check required labels
  for (const label of REQUIRED_OCI_LABELS) {
    const value = labels[label];
    if (!value) {
      results.push({
        name: `OCI Label: ${label}`,
        passed: false,
        critical: true,
        message: "Missing required label",
      });
    } else {
      results.push({
        name: `OCI Label: ${label}`,
        passed: true,
        critical: true,
        message: value,
      });
    }
  }

  // Check recommended labels
  for (const label of RECOMMENDED_OCI_LABELS) {
    const value = labels[label];
    if (!value) {
      results.push({
        name: `OCI Label: ${label}`,
        passed: true,
        critical: false,
        message: "Missing recommended label",
      });
    } else {
      results.push({
        name: `OCI Label: ${label}`,
        passed: true,
        critical: false,
        message: value,
      });
    }
  }

  return results;
}

function validateExposedPorts(imageData: ImageData): ValidationResult {
  const exposedPorts = Object.keys(imageData.Config.ExposedPorts || {});

  if (!exposedPorts.includes("5432/tcp")) {
    return {
      name: "PostgreSQL Port (5432)",
      passed: false,
      critical: true,
      message: "Port 5432/tcp not exposed",
    };
  }

  return {
    name: "PostgreSQL Port (5432)",
    passed: true,
    critical: true,
    message: exposedPorts.join(", "),
  };
}

function validateUser(imageData: ImageData): ValidationResult {
  const user = imageData.Config.User;

  if (!user) {
    return {
      name: "User",
      passed: true,
      critical: false,
      message: "No user specified (will run as root)",
    };
  }

  if (user !== "postgres") {
    return {
      name: "User",
      passed: true,
      critical: false,
      message: `User is '${user}' (expected 'postgres')`,
    };
  }

  return {
    name: "User",
    passed: true,
    critical: false,
    message: user,
  };
}

function validateWorkdir(imageData: ImageData): ValidationResult {
  const workdir = imageData.Config.WorkingDir;

  if (!workdir) {
    return {
      name: "Working Directory",
      passed: true,
      critical: false,
      message: "No working directory specified",
    };
  }

  return {
    name: "Working Directory",
    passed: true,
    critical: false,
    message: workdir,
  };
}

function validateEntrypoint(imageData: ImageData): ValidationResult {
  const entrypoint = imageData.Config.Entrypoint;
  const cmd = imageData.Config.Cmd;

  if (!entrypoint && !cmd) {
    return {
      name: "Entrypoint/CMD",
      passed: false,
      critical: true,
      message: "Neither ENTRYPOINT nor CMD specified",
    };
  }

  const parts: string[] = [];
  if (entrypoint) {
    parts.push(`ENTRYPOINT: ${entrypoint.join(" ")}`);
  }
  if (cmd) {
    parts.push(`CMD: ${cmd.join(" ")}`);
  }

  return {
    name: "Entrypoint/CMD",
    passed: true,
    critical: false,
    message: parts.join(", "),
  };
}

function validateLayerCount(imageData: ImageData): ValidationResult {
  const layers = imageData.RootFS?.Layers || [];
  const count = layers.length;

  if (count > 30) {
    return {
      name: "Layer Count",
      passed: true,
      critical: false,
      message: `${count} layers (warning: exceeds 30, consider optimization)`,
    };
  }

  return {
    name: "Layer Count",
    passed: true,
    critical: false,
    message: `${count} layers`,
  };
}

function validateArchitecture(imageData: ImageData): ValidationResult {
  const arch = imageData.Architecture;
  const os = imageData.Os;
  const platform = `${os}/${arch}`;

  if (os !== "linux") {
    return {
      name: "Platform",
      passed: false,
      critical: true,
      message: `Unexpected OS: ${platform} (expected linux/*)`,
    };
  }

  if (arch !== "amd64" && arch !== "arm64") {
    return {
      name: "Platform",
      passed: true,
      critical: false,
      message: `Unusual architecture: ${platform}`,
    };
  }

  return {
    name: "Platform",
    passed: true,
    critical: false,
    message: platform,
  };
}

function printValidationResult(result: ValidationResult): void {
  const suffix = result.message ? `: ${result.message}` : "";

  if (result.passed) {
    if (result.message?.includes("warning:") || result.message?.includes("Missing recommended")) {
      warning(`${result.name}${suffix}`);
    } else {
      success(`${result.name}${suffix}`);
    }
  } else {
    error(`${result.name}${suffix}`);
  }
}

function printImageInfo(imageData: ImageData): void {
  section("Image Information");

  const shortId = imageData.Id.replace("sha256:", "").slice(0, 12);
  info(`Image ID: ${shortId}`);
  info(`Created: ${formatTimestamp(imageData.Created)}`);

  if (imageData.RepoTags && imageData.RepoTags.length > 0) {
    info(`Tags: ${imageData.RepoTags.join(", ")}`);
  }

  console.log();
}

async function validateImage(imageTag: string): Promise<number> {
  section(`Validating Image: ${imageTag}`);
  console.log();

  // Inspect image
  info("Inspecting image...");
  let imageData: ImageData | null = null;
  try {
    imageData = await inspectImage(imageTag);
  } catch (err) {
    error(`Failed to inspect image: ${getErrorMessage(err)}`);
  }

  // Collect all validation results
  const results: ValidationResult[] = [];

  // Critical: Image exists
  const existsResult = validateImageExists(imageData, imageTag);
  results.push(existsResult);

  if (!imageData) {
    // Cannot proceed without image data
    console.log();
    separator();
    printValidationResult(existsResult);
    separator();
    console.log();
    error("Cannot validate image: inspection failed");
    return 1;
  }

  // Print image info
  console.log();
  printImageInfo(imageData);

  // Run all validations
  results.push(validateDigest(imageData));
  results.push(validateImageSize(imageData));
  results.push(await validateCompressedSize(imageTag, imageData));
  results.push(...validateOciLabels(imageData));
  results.push(validateExposedPorts(imageData));
  results.push(validateUser(imageData));
  results.push(validateWorkdir(imageData));
  results.push(validateEntrypoint(imageData));
  results.push(validateLayerCount(imageData));
  results.push(validateArchitecture(imageData));

  // Print results
  section("Validation Results");
  console.log();

  for (const result of results) {
    printValidationResult(result);
  }

  // Summary
  console.log();
  separator();

  const totalChecks = results.length;
  const passedChecks = results.filter((r) => r.passed).length;
  const failedChecks = results.filter((r) => !r.passed).length;
  const criticalFailures = results.filter((r) => !r.passed && r.critical).length;
  const warnings = results.filter(
    (r) =>
      r.passed && (r.message?.includes("warning:") || r.message?.includes("Missing recommended"))
  ).length;

  info(`Total Checks: ${totalChecks}`);
  success(`Passed: ${passedChecks}`);
  if (failedChecks > 0) {
    error(`Failed: ${failedChecks}`);
  }
  if (criticalFailures > 0) {
    error(`Critical Failures: ${criticalFailures}`);
  }
  if (warnings > 0) {
    warning(`Warnings: ${warnings}`);
  }

  separator();

  // Exit code
  if (criticalFailures > 0) {
    console.log();
    error("Validation failed: critical checks did not pass");
    return 1;
  }

  console.log();
  success("All critical checks passed!");

  if (warnings > 0) {
    console.log();
    warning(`Note: ${warnings} warning(s) found (non-critical)`);
  }

  return 0;
}

async function main(): Promise<void> {
  // Handle --help
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Resolve image tag
  const { image: imageTag, source } = resolveImageWithSource();
  info(`Image source: ${source}`);
  console.log();

  // Check Docker availability
  await checkDockerAvailable();

  // Validate image
  const exitCode = await validateImage(imageTag);
  process.exit(exitCode);
}

main();
