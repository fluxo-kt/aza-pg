/**
 * Runtime validation schemas for extension manifest using ArkType.
 * This module provides comprehensive type-safe validation for the extension
 * manifest structure defined in manifest-data.ts.
 *
 * @module manifest-schema
 */

import { type } from "arktype";

/**
 * Source specification schema - discriminated union for different source types.
 *
 * Supports three source types:
 * - builtin: Built-in PostgreSQL extension (no additional fields)
 * - git: Git repository with semantic version tag
 * - git-ref: Git repository with specific commit reference
 */
export const SourceSpecSchema = type({
  type: "'builtin'",
})
  .or({
    type: "'git'",
    repository: "string",
    tag: "string",
  })
  .or({
    type: "'git-ref'",
    repository: "string",
    ref: "string",
  });

/**
 * Build system type - literal union of supported build systems.
 */
export const BuildKindSchema = type(
  "'pgxs'|'cargo-pgrx'|'timescaledb'|'autotools'|'cmake'|'meson'|'make'|'script'"
);

/**
 * Build specification schema - configuration for building extensions from source.
 *
 * Fields:
 * - type: Build system to use (required)
 * - subdir: Optional subdirectory within repository to build
 * - features: Optional Cargo feature flags (for cargo-pgrx builds)
 * - noDefaultFeatures: Disable default Cargo features (for cargo-pgrx builds)
 * - script: Optional script identifier for custom build logic
 * - patches: Optional sed expressions to apply before building
 */
export const BuildSpecSchema = type({
  type: BuildKindSchema,
  "subdir?": "string",
  "features?": "string[]",
  "noDefaultFeatures?": "boolean",
  "script?": "string",
  "patches?": "string[]",
});

/**
 * Runtime specification schema - configuration for extension runtime behavior.
 *
 * Fields:
 * - sharedPreload: Whether extension requires shared_preload_libraries
 * - defaultEnable: Whether extension should be enabled by default
 * - preloadOnly: Whether extension is SQL-only schema (no CREATE EXTENSION support)
 * - notes: Optional runtime configuration notes for users
 */
export const RuntimeSpecSchema = type({
  "sharedPreload?": "boolean",
  "defaultEnable?": "boolean",
  "preloadOnly?": "boolean",
  "notes?": "string[]",
});

/**
 * Extension kind - literal union of valid extension types.
 */
export const ExtensionKindSchema = type("'extension'|'tool'|'builtin'");

/**
 * Complete manifest entry schema - validates a single extension catalog entry.
 *
 * Required fields:
 * - name: Unique extension identifier
 * - kind: Extension type (extension/tool/builtin)
 * - category: Extension category for organization
 * - description: Human-readable description
 * - source: Source specification (where to get the extension)
 *
 * Optional fields:
 * - displayName: Alternative display name
 * - build: Build configuration (required for non-builtin sources)
 * - runtime: Runtime behavior configuration
 * - dependencies: List of extension dependencies
 * - provides: List of features/extensions provided
 * - aptPackages: System packages required for building
 * - notes: General notes about the extension
 * - install_via: Installation method override (currently only "pgdg")
 * - enabled: Whether extension is enabled (defaults to true if not specified)
 */
export const ManifestEntrySchema = type({
  name: "string",
  "displayName?": "string",
  kind: ExtensionKindSchema,
  category: "string",
  description: "string",
  source: SourceSpecSchema,
  "build?": BuildSpecSchema,
  "runtime?": RuntimeSpecSchema,
  "dependencies?": "string[]",
  "provides?": "string[]",
  "aptPackages?": "string[]",
  "notes?": "string[]",
  "install_via?": "'pgdg'",
  "enabled?": "boolean",
});

/**
 * Complete manifest schema - array of manifest entries.
 */
export const ManifestSchema = ManifestEntrySchema.array();

/**
 * Validates manifest data at runtime.
 *
 * @param data - Unknown data to validate as manifest
 * @returns Validated manifest data
 * @throws Error if validation fails with detailed error messages
 *
 * @example
 * ```typescript
 * try {
 *   const manifest = validateManifest(rawData);
 *   // manifest is now type-safe
 * } catch (error) {
 *   console.error('Manifest validation failed:', error.message);
 * }
 * ```
 */
export function validateManifest(data: unknown): ValidatedManifest {
  const result = ManifestSchema(data);
  if (result instanceof type.errors) {
    throw new Error(`Manifest validation failed:\n${result.summary}`);
  }
  return result;
}

/**
 * Validates a single manifest entry at runtime.
 *
 * @param data - Unknown data to validate as manifest entry
 * @returns Validated manifest entry
 * @throws Error if validation fails with detailed error messages
 *
 * @example
 * ```typescript
 * try {
 *   const entry = validateManifestEntry(rawEntry);
 *   // entry is now type-safe
 * } catch (error) {
 *   console.error('Entry validation failed:', error.message);
 * }
 * ```
 */
export function validateManifestEntry(data: unknown): ValidatedManifestEntry {
  const result = ManifestEntrySchema(data);
  if (result instanceof type.errors) {
    throw new Error(`Manifest entry validation failed:\n${result.summary}`);
  }
  return result;
}

/**
 * Validates source specification at runtime.
 *
 * @param data - Unknown data to validate as source spec
 * @returns Validated source specification
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * const source = validateSourceSpec({
 *   type: "git",
 *   repository: "https://github.com/user/repo.git",
 *   tag: "v1.0.0"
 * });
 * ```
 */
export function validateSourceSpec(data: unknown): ValidatedSourceSpec {
  const result = SourceSpecSchema(data);
  if (result instanceof type.errors) {
    throw new Error(`Source spec validation failed:\n${result.summary}`);
  }
  return result;
}

/**
 * Validates build specification at runtime.
 *
 * @param data - Unknown data to validate as build spec
 * @returns Validated build specification
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * const build = validateBuildSpec({
 *   type: "pgxs",
 *   patches: ["s/old/new/"]
 * });
 * ```
 */
export function validateBuildSpec(data: unknown): ValidatedBuildSpec {
  const result = BuildSpecSchema(data);
  if (result instanceof type.errors) {
    throw new Error(`Build spec validation failed:\n${result.summary}`);
  }
  return result;
}

/**
 * Validates runtime specification at runtime.
 *
 * @param data - Unknown data to validate as runtime spec
 * @returns Validated runtime specification
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * const runtime = validateRuntimeSpec({
 *   sharedPreload: true,
 *   defaultEnable: false
 * });
 * ```
 */
export function validateRuntimeSpec(data: unknown): ValidatedRuntimeSpec {
  const result = RuntimeSpecSchema(data);
  if (result instanceof type.errors) {
    throw new Error(`Runtime spec validation failed:\n${result.summary}`);
  }
  return result;
}

// Inferred types from ArkType schemas
export type ValidatedSourceSpec = typeof SourceSpecSchema.infer;
export type ValidatedBuildKind = typeof BuildKindSchema.infer;
export type ValidatedBuildSpec = typeof BuildSpecSchema.infer;
export type ValidatedRuntimeSpec = typeof RuntimeSpecSchema.infer;
export type ValidatedExtensionKind = typeof ExtensionKindSchema.infer;
export type ValidatedManifestEntry = typeof ManifestEntrySchema.infer;
export type ValidatedManifest = typeof ManifestSchema.infer;
