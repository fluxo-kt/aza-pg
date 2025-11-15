#!/usr/bin/env bun

/**
 * Sign container image tags using Cosign with keyless OIDC
 *
 * This script signs released container images with Cosign for supply chain security.
 * Uses keyless OIDC signing (GitHub OIDC token) to sign multiple tags in a single command.
 * Replaces inline `cosign sign` blocks in publish.yml (lines 899-901).
 *
 * RELEASE-CRITICAL: Production release signature verification
 *
 * Usage:
 *   bun scripts/release/sign-tags.ts --repository REPO --tags TAG1,TAG2,... [OPTIONS]
 *
 * Required options:
 *   --repository REPO     Repository to sign (e.g., "ghcr.io/fluxo-kt/aza-pg")
 *   --tags CSV            Comma-separated list of tags to sign
 *
 * Optional flags:
 *   --yes                 Auto-confirm signing (COSIGN_YES=true)
 *   --recursive           Sign all layers recursively
 *   --dry-run             Show signing commands without executing
 *   --help                Show this help message
 *
 * Examples:
 *   # Basic signing with keyless OIDC
 *   bun scripts/release/sign-tags.ts \
 *     --repository ghcr.io/fluxo-kt/aza-pg \
 *     --tags 18.1-202511142330-single-node,18.1-single-node,18-single-node \
 *     --yes
 *
 *   # Signing with recursive flag (sign all layers)
 *   bun scripts/release/sign-tags.ts \
 *     --repository ghcr.io/fluxo-kt/aza-pg \
 *     --tags 18-single-node \
 *     --yes \
 *     --recursive
 *
 *   # Dry-run mode (show commands without executing)
 *   bun scripts/release/sign-tags.ts \
 *     --repository ghcr.io/fluxo-kt/aza-pg \
 *     --tags 18.1-202511142330-single-node,18.1-single-node \
 *     --dry-run
 *
 *   # Usage in publish.yml workflow
 *   - name: Sign production tags
 *     env:
 *       COSIGN_EXPERIMENTAL: "1"
 *     run: |
 *       bun scripts/release/sign-tags.ts \
 *         --repository ghcr.io/fluxo-kt/aza-pg \
 *         --tags "${{ needs.prep.outputs.tag_versioned }},${{ needs.prep.outputs.pg_version_full }}-single-node,${{ needs.prep.outputs.pg_version_major }}-single-node" \
 *         --yes
 *
 * Cosign Keyless OIDC Details:
 *   - COSIGN_EXPERIMENTAL=1 enables keyless mode
 *   - Uses GitHub OIDC token for signing (no private key needed)
 *   - Signature stored in Rekor transparency log (sigstore.dev)
 *   - Verification: cosign verify --certificate-identity=... --certificate-oidc-issuer=... <image>
 *   - --yes flag auto-confirms signing (non-interactive)
 *
 * Security Notes:
 *   - Keyless signing uses ephemeral keys (Fulcio CA)
 *   - OIDC token proves identity (GitHub Actions workflow)
 *   - Transparency log provides auditability (Rekor)
 *   - No long-lived private keys to manage
 *
 * Exit codes:
 *   0 - All tags signed successfully
 *   1 - Any signing failed or validation error
 */

import { $ } from "bun";
import { error, success, info, warning } from "../utils/logger.js";
import { getErrorMessage } from "../utils/errors.js";

interface Options {
  repository: string;
  tags: string[];
  yes: boolean;
  recursive: boolean;
  dryRun: boolean;
}

function printHelp(): void {
  const helpText = `
Sign container image tags using Cosign with keyless OIDC

This script signs released container images with Cosign for supply chain security.
Uses keyless OIDC signing (GitHub OIDC token) to sign multiple tags in a single command.

RELEASE-CRITICAL: Production release signature verification

Usage:
  bun scripts/release/sign-tags.ts --repository REPO --tags TAG1,TAG2,... [OPTIONS]

Required options:
  --repository REPO     Repository to sign (e.g., "ghcr.io/fluxo-kt/aza-pg")
  --tags CSV            Comma-separated list of tags to sign

Optional flags:
  --yes                 Auto-confirm signing (COSIGN_YES=true)
  --recursive           Sign all layers recursively
  --dry-run             Show signing commands without executing
  --help                Show this help message

Examples:
  # Basic signing with keyless OIDC
  bun scripts/release/sign-tags.ts \\
    --repository ghcr.io/fluxo-kt/aza-pg \\
    --tags 18.1-202511142330-single-node,18.1-single-node,18-single-node \\
    --yes

  # Signing with recursive flag (sign all layers)
  bun scripts/release/sign-tags.ts \\
    --repository ghcr.io/fluxo-kt/aza-pg \\
    --tags 18-single-node \\
    --yes \\
    --recursive

  # Dry-run mode (show commands without executing)
  bun scripts/release/sign-tags.ts \\
    --repository ghcr.io/fluxo-kt/aza-pg \\
    --tags 18.1-202511142330-single-node,18.1-single-node \\
    --dry-run

  # Usage in publish.yml workflow
  - name: Sign production tags
    env:
      COSIGN_EXPERIMENTAL: "1"
    run: |
      bun scripts/release/sign-tags.ts \\
        --repository ghcr.io/fluxo-kt/aza-pg \\
        --tags "\${{ needs.prep.outputs.tag_versioned }},\${{ needs.prep.outputs.pg_version_full }}-single-node,\${{ needs.prep.outputs.pg_version_major }}-single-node" \\
        --yes

Cosign Keyless OIDC Details:
  - COSIGN_EXPERIMENTAL=1 enables keyless mode
  - Uses GitHub OIDC token for signing (no private key needed)
  - Signature stored in Rekor transparency log (sigstore.dev)
  - Verification: cosign verify --certificate-identity=... --certificate-oidc-issuer=... <image>
  - --yes flag auto-confirms signing (non-interactive)

Security Notes:
  - Keyless signing uses ephemeral keys (Fulcio CA)
  - OIDC token proves identity (GitHub Actions workflow)
  - Transparency log provides auditability (Rekor)
  - No long-lived private keys to manage

Exit codes:
  0 - All tags signed successfully
  1 - Any signing failed or validation error
`;
  console.log(helpText.trim());
}

function parseArgs(): Options {
  const args = Bun.argv.slice(2);

  const options: Options = {
    repository: "",
    tags: [],
    yes: false,
    recursive: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--repository":
        if (i + 1 >= args.length) {
          error("--repository requires an argument");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--repository requires an argument");
            process.exit(1);
          }
          options.repository = value;
        }
        i++;
        break;

      case "--tags":
        if (i + 1 >= args.length) {
          error("--tags requires a comma-separated list");
          process.exit(1);
        }
        {
          const value = args[i + 1];
          if (!value) {
            error("--tags requires a comma-separated list");
            process.exit(1);
          }
          // Parse comma-separated tags and filter out empty strings
          options.tags = value
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);
        }
        i++;
        break;

      case "--yes":
        options.yes = true;
        break;

      case "--recursive":
        options.recursive = true;
        break;

      case "--dry-run":
        options.dryRun = true;
        break;

      default:
        error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  // Validate required options
  if (!options.repository) {
    error("--repository is required");
    printHelp();
    process.exit(1);
  }

  if (options.tags.length === 0) {
    error("--tags is required and must contain at least one tag");
    printHelp();
    process.exit(1);
  }

  return options;
}

async function checkCosignAvailable(): Promise<void> {
  try {
    const result = await $`cosign version`.nothrow().quiet();
    if (result.exitCode !== 0) {
      error("Cosign is not available or not installed");
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log("::error::Cosign is not available or not installed");
      }
      process.exit(1);
    }
  } catch (err) {
    error(`Failed to check Cosign availability: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to check Cosign availability: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function checkOIDCToken(): Promise<void> {
  // Check if running in GitHub Actions with OIDC token available
  if (Bun.env.GITHUB_ACTIONS === "true") {
    if (!Bun.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
      warning("OIDC token not available (ACTIONS_ID_TOKEN_REQUEST_TOKEN not set)");
      warning("Make sure workflow has 'id-token: write' permission");
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log("::warning::OIDC token not available - ensure 'id-token: write' permission");
      }
    }
  }

  // Check if COSIGN_EXPERIMENTAL is set
  if (Bun.env.COSIGN_EXPERIMENTAL !== "1") {
    warning("COSIGN_EXPERIMENTAL is not set to 1 - keyless signing may not work");
    warning("Set 'COSIGN_EXPERIMENTAL=1' environment variable for keyless mode");
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log("::warning::COSIGN_EXPERIMENTAL not set - keyless signing may fail");
    }
  }
}

async function signImage(repository: string, tag: string, options: Options): Promise<void> {
  const imageRef = `${repository}:${tag}`;

  try {
    // Build cosign command
    const args = ["sign"];

    if (options.yes) {
      args.push("--yes");
    }

    if (options.recursive) {
      args.push("-r");
    }

    args.push(imageRef);

    if (options.dryRun) {
      info(`[DRY RUN] Would sign: ${imageRef}`);
      console.log(`  Command: cosign ${args.join(" ")}`);
      return;
    }

    info(`Signing: ${imageRef}`);

    const result = await $`cosign ${args}`.nothrow();

    if (result.exitCode !== 0) {
      error(`Failed to sign image: ${imageRef}`);
      if (Bun.env.GITHUB_ACTIONS === "true") {
        console.log(`::error::Failed to sign image ${imageRef}`);
      }
      // Fail fast on first error
      process.exit(1);
    }

    success(`Signed: ${imageRef}`);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::notice::Successfully signed image: ${imageRef}`);
    }
  } catch (err) {
    error(`Failed to sign ${imageRef}: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Failed to sign ${imageRef}: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

async function signTags(options: Options): Promise<void> {
  const { repository, tags, dryRun } = options;

  // Check Cosign availability
  await checkCosignAvailable();

  // Check OIDC token availability (warnings only)
  await checkOIDCToken();

  // Sign each tag sequentially (can't batch sign different tags)
  if (dryRun) {
    info(
      `[DRY RUN] Would sign ${tags.length} tag${tags.length !== 1 ? "s" : ""} in repository: ${repository}`
    );
  } else {
    info(`Signing ${tags.length} tag${tags.length !== 1 ? "s" : ""} in repository: ${repository}`);
  }

  for (const tag of tags) {
    await signImage(repository, tag, options);
  }

  if (dryRun) {
    success(`[DRY RUN] Would sign all ${tags.length} tag${tags.length !== 1 ? "s" : ""}`);
  } else {
    success(`Successfully signed all ${tags.length} tag${tags.length !== 1 ? "s" : ""}`);

    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log("::notice::All image tags signed successfully with keyless OIDC");
      console.log("::notice::Signatures uploaded to Rekor transparency log");
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  try {
    await signTags(options);
  } catch (err) {
    error(`Unexpected error: ${getErrorMessage(err)}`);
    if (Bun.env.GITHUB_ACTIONS === "true") {
      console.log(`::error::Unexpected error: ${getErrorMessage(err)}`);
    }
    process.exit(1);
  }
}

main();
