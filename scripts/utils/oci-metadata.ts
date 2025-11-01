/**
 * Shared OCI Metadata Utilities
 *
 * Common functionality for OCI Image annotations used across:
 * - scripts/release/promote-image.ts
 * - scripts/docker/create-manifest.ts
 *
 * Provides:
 * - Common OCI metadata options interface
 * - CLI argument parsing for OCI annotations
 * - OCI annotation building from options
 *
 * Follows OCI Image Format Specification:
 * https://github.com/opencontainers/image-spec/blob/main/annotations.md
 */

import { error } from "./logger";

/**
 * OCI metadata options (all optional)
 * Maps to standard OCI annotation keys (org.opencontainers.image.*)
 * and custom aza-pg annotations (io.fluxo-kt.aza-pg.*)
 */
export interface OCIMetadataOptions {
  // Standard OCI annotations
  version?: string; // org.opencontainers.image.version
  revision?: string; // org.opencontainers.image.revision
  sourceUrl?: string; // org.opencontainers.image.source
  title?: string; // org.opencontainers.image.title
  description?: string; // org.opencontainers.image.description
  created?: string; // org.opencontainers.image.created (RFC 3339)
  authors?: string; // org.opencontainers.image.authors
  url?: string; // org.opencontainers.image.url
  documentation?: string; // org.opencontainers.image.documentation
  licenses?: string; // org.opencontainers.image.licenses (SPDX format)

  // Base image references
  baseImageName?: string; // org.opencontainers.image.base.name
  baseImageDigest?: string; // org.opencontainers.image.base.digest

  // Custom aza-pg annotations
  pgVersion?: string; // io.fluxo-kt.aza-pg.postgresql.version
  catalogEnabled?: string; // io.fluxo-kt.aza-pg.catalog.enabled
  catalogTotal?: string; // io.fluxo-kt.aza-pg.catalog.total
}

/**
 * Parse CLI arguments for OCI metadata flags
 * Modifies args array in-place, returns parsed options
 *
 * Supported flags:
 * --version, --revision, --source-url, --title, --description, --created,
 * --authors, --url, --documentation, --licenses, --base-image-name,
 * --base-image-digest, --pg-version, --catalog-enabled, --catalog-total
 *
 * @param args - Argument array to parse (will be modified in-place)
 * @param i - Current argument index (will be updated)
 * @param options - Options object to populate
 * @returns true if argument was parsed, false otherwise
 */
export function parseOCIMetadataArg(
  args: string[],
  i: { value: number },
  options: OCIMetadataOptions
): boolean {
  const arg = args[i.value];

  // Helper to get next argument value
  const getNextArg = (flagName: string): string => {
    if (i.value + 1 >= args.length) {
      error(`${flagName} requires an argument`);
      process.exit(1);
    }
    const value = args[i.value + 1];
    if (!value) {
      error(`${flagName} requires an argument`);
      process.exit(1);
    }
    i.value++;
    return value;
  };

  switch (arg) {
    // Standard OCI annotations
    case "--version":
      options.version = getNextArg("--version");
      return true;

    case "--revision":
      options.revision = getNextArg("--revision");
      return true;

    case "--source-url":
      options.sourceUrl = getNextArg("--source-url");
      return true;

    case "--title":
      options.title = getNextArg("--title");
      return true;

    case "--description":
      options.description = getNextArg("--description");
      return true;

    case "--created":
      options.created = getNextArg("--created");
      return true;

    case "--authors":
      options.authors = getNextArg("--authors");
      return true;

    case "--url":
      options.url = getNextArg("--url");
      return true;

    case "--documentation":
      options.documentation = getNextArg("--documentation");
      return true;

    case "--licenses":
      options.licenses = getNextArg("--licenses");
      return true;

    // Base image references
    case "--base-image-name":
      options.baseImageName = getNextArg("--base-image-name");
      return true;

    case "--base-image-digest":
      options.baseImageDigest = getNextArg("--base-image-digest");
      return true;

    // Custom aza-pg annotations
    case "--pg-version":
      options.pgVersion = getNextArg("--pg-version");
      return true;

    case "--catalog-enabled":
      options.catalogEnabled = getNextArg("--catalog-enabled");
      return true;

    case "--catalog-total":
      options.catalogTotal = getNextArg("--catalog-total");
      return true;

    default:
      return false;
  }
}

/**
 * Build OCI annotations object from metadata options
 *
 * Maps OCIMetadataOptions to OCI annotation key-value pairs:
 * - Standard OCI keys: org.opencontainers.image.*
 * - Custom aza-pg keys: io.fluxo-kt.aza-pg.*
 *
 * @param options - OCI metadata options
 * @param autoGenerateCreated - Auto-generate created timestamp if not provided (default: false)
 * @returns Object with annotation key-value pairs
 */
export function buildOCIAnnotations(
  options: OCIMetadataOptions,
  autoGenerateCreated: boolean = false
): Record<string, string> {
  const annotations: Record<string, string> = {};

  // Standard OCI annotations
  if (options.version) {
    annotations["org.opencontainers.image.version"] = options.version;
  }

  if (options.revision) {
    annotations["org.opencontainers.image.revision"] = options.revision;
  }

  if (options.sourceUrl) {
    annotations["org.opencontainers.image.source"] = options.sourceUrl;
  }

  if (options.title) {
    annotations["org.opencontainers.image.title"] = options.title;
  }

  if (options.description) {
    annotations["org.opencontainers.image.description"] = options.description;
  }

  // Created timestamp: use provided or auto-generate if enabled
  if (options.created) {
    annotations["org.opencontainers.image.created"] = options.created;
  } else if (autoGenerateCreated) {
    annotations["org.opencontainers.image.created"] = new Date().toISOString();
  }

  if (options.authors) {
    annotations["org.opencontainers.image.authors"] = options.authors;
  }

  if (options.url) {
    annotations["org.opencontainers.image.url"] = options.url;
  }

  if (options.documentation) {
    annotations["org.opencontainers.image.documentation"] = options.documentation;
  }

  if (options.licenses) {
    annotations["org.opencontainers.image.licenses"] = options.licenses;
  }

  // Base image references
  if (options.baseImageName) {
    annotations["org.opencontainers.image.base.name"] = options.baseImageName;
  }

  if (options.baseImageDigest) {
    annotations["org.opencontainers.image.base.digest"] = options.baseImageDigest;
  }

  // Custom aza-pg annotations
  if (options.pgVersion) {
    annotations["io.fluxo-kt.aza-pg.postgresql.version"] = options.pgVersion;
  }

  if (options.catalogEnabled) {
    annotations["io.fluxo-kt.aza-pg.catalog.enabled"] = options.catalogEnabled;
  }

  if (options.catalogTotal) {
    annotations["io.fluxo-kt.aza-pg.catalog.total"] = options.catalogTotal;
  }

  return annotations;
}

/**
 * Validate OCI metadata options
 *
 * Checks for common issues:
 * - description length (GHCR limit: 512 chars)
 * - licenses format (should be SPDX identifier, max 256 chars for GHCR)
 * - created format (should be RFC 3339 / ISO 8601)
 *
 * @param options - OCI metadata options to validate
 * @returns Validation errors (empty array if valid)
 */
export function validateOCIMetadata(options: OCIMetadataOptions): string[] {
  const errors: string[] = [];

  // Validate description length (GHCR limit)
  if (options.description && options.description.length > 512) {
    errors.push(
      `Description exceeds GHCR limit of 512 characters (${options.description.length} chars)`
    );
  }

  // Validate licenses length (GHCR limit)
  if (options.licenses && options.licenses.length > 256) {
    errors.push(`Licenses exceeds GHCR limit of 256 characters (${options.licenses.length} chars)`);
  }

  // Validate created timestamp format (basic ISO 8601 check)
  if (options.created) {
    const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    if (!iso8601Regex.test(options.created)) {
      errors.push(`Created timestamp must be in RFC 3339 / ISO 8601 format: ${options.created}`);
    }
  }

  return errors;
}
