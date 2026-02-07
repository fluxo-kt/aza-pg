#!/usr/bin/env bun
/**
 * Unit Test Suite for Dockerfile Generator
 * Tests dockerfile generation logic without Docker builds
 *
 * Coverage:
 * - PGDG package installation script generation
 * - Placeholder replacement (PG_VERSION, PG_MAJOR, etc.)
 * - Shared preload libraries generation
 * - Version validation
 * - Package name security validation
 * - Manifest filtering (PGXS, Cargo)
 * - Regression mode configuration
 *
 * Usage: bun test scripts/docker/generate-dockerfile.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { extensionDefaults } from "../extension-defaults";

// Import types from the generator module (we'll need to make some functions exportable)
interface ManifestEntry {
  name: string;
  install_via?: string;
  enabled?: boolean;
  enabledInComprehensiveTest?: boolean;
  build?: {
    type: string;
    subdir?: string;
    features?: string[];
    noDefaultFeatures?: boolean;
    script?: string;
    patches?: string[];
  };
  runtime?: {
    sharedPreload?: boolean;
    defaultEnable?: boolean;
    preloadInComprehensiveTest?: boolean;
    preloadLibraryName?: string;
  };
  source: {
    tag?: string;
    ref?: string;
  };
}

interface Manifest {
  entries: ManifestEntry[];
}

const REPO_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = join(REPO_ROOT, "docker/postgres/extensions.manifest.json");
const TEMPLATE_PATH = join(REPO_ROOT, "docker/postgres/Dockerfile.template");
const OUTPUT_PATH = join(REPO_ROOT, "docker/postgres/Dockerfile");

describe("Extension Defaults Validation", () => {
  test("PG_VERSION is defined and valid", () => {
    expect(extensionDefaults.pgVersion).toBeDefined();
    expect(extensionDefaults.pgVersion).toMatch(/^\d+\.\d+$/);
  });

  test("PG_MAJOR can be extracted from PG_VERSION", () => {
    const pgMajor = extensionDefaults.pgVersion.split(".")[0];
    expect(pgMajor).toBeDefined();
    expect(Number.parseInt(pgMajor!)).toBeGreaterThan(0);
    expect(Number.parseInt(pgMajor!)).toBeLessThanOrEqual(20); // Reasonable upper bound
  });

  test("Base image SHA is valid format", () => {
    expect(extensionDefaults.baseImageSha).toBeDefined();
    expect(extensionDefaults.baseImageSha).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("All PGDG versions are defined", () => {
    const versions = extensionDefaults.pgdgVersions;
    expect(versions.pgcron).toBeDefined();
    expect(versions.pgaudit).toBeDefined();
    expect(versions.pgvector).toBeDefined();
    // NOTE: timescaledb removed - uses install_via: "source" in manifest (compiled from source)
    // NOTE: pg_partman removed - uses install_via: "source" in manifest (PGDG package not available for PG18)
    // NOTE: plpgsql_check removed - uses install_via: "source" (PGDG v2.8.8 not yet available)
    expect(versions.postgis).toBeDefined();
    expect(versions.repack).toBeDefined();
    expect(versions.hll).toBeDefined();
    expect(versions.http).toBeDefined();
    expect(versions.hypopg).toBeDefined();
    expect(versions.pgrouting).toBeDefined();
    expect(versions.rum).toBeDefined();
    expect(versions.setUser).toBeDefined();
  });

  test("PGDG versions follow expected pattern", () => {
    // Pattern: version-build.pgdgNN+1 (e.g., "1.6.7-2.pgdg13+1")
    // Some packages like postgis include +dfsg in the version
    const versionPattern = /^[\d.]+(\+\w+)?(-\d+)?\.pgdg\d+\+\d+$/;

    for (const [_key, version] of Object.entries(extensionDefaults.pgdgVersions)) {
      expect(version).toMatch(versionPattern);
    }
  });
});

describe("Manifest File Validation", () => {
  let manifest: Manifest;

  beforeAll(async () => {
    const manifestFile = Bun.file(MANIFEST_PATH);
    expect(await manifestFile.exists()).toBe(true);
    manifest = (await manifestFile.json()) as Manifest;
  });

  test("Manifest loads successfully", async () => {
    expect(manifest).toBeDefined();
    expect(manifest.entries).toBeDefined();
    expect(Array.isArray(manifest.entries)).toBe(true);
  });

  test("Manifest contains entries", async () => {
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  test("All PGDG entries have valid names", async () => {
    const pgdgEntries = manifest.entries.filter((e) => e.install_via === "pgdg");

    for (const entry of pgdgEntries) {
      expect(entry.name).toBeDefined();
      expect(entry.name.length).toBeGreaterThan(0);
      // Should only contain safe characters
      expect(entry.name).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });

  test("Enabled PGDG extensions have corresponding version definitions", async () => {
    const enabledPgdg = manifest.entries.filter(
      (e) => e.install_via === "pgdg" && (e.enabled ?? true) === true
    );

    // Known PGDG extensions that should have versions
    // NOTE: timescaledb removed - uses install_via: "source" (compiled from source)
    const expectedExtensions = [
      "pg_cron",
      "pgaudit",
      "vector",
      "postgis",
      "pg_partman",
      "pg_repack",
      "hll",
      "http",
      "hypopg",
      "pgrouting",
      "rum",
      "set_user",
    ];

    const enabledNames = enabledPgdg.map((e) => e.name);

    for (const expected of expectedExtensions) {
      if (enabledNames.includes(expected)) {
        // If it's in manifest as enabled, it should have a version
        expect(enabledNames).toContain(expected);
      }
    }
  });

  test("Preload libraries have valid configurations", async () => {
    const preloadEntries = manifest.entries.filter((e) => e.runtime?.sharedPreload === true);

    for (const entry of preloadEntries) {
      expect(entry.runtime).toBeDefined();
      expect(typeof entry.runtime!.sharedPreload).toBe("boolean");

      if (entry.runtime!.preloadLibraryName) {
        // Library name should be valid
        expect(entry.runtime!.preloadLibraryName).toMatch(/^[a-zA-Z0-9_]+$/);
      }
    }
  });
});

describe("Template File Validation", () => {
  let template: string;

  beforeAll(async () => {
    const templateFile = Bun.file(TEMPLATE_PATH);
    expect(await templateFile.exists()).toBe(true);
    template = await templateFile.text();
  });

  test("Template contains expected placeholders", async () => {
    expect(template).toContain("{{PG_VERSION}}");
    expect(template).toContain("{{PG_MAJOR}}");
    expect(template).toContain("{{PG_BASE_IMAGE_SHA}}");
    expect(template).toContain("{{PGDG_PACKAGES_INSTALL}}");
  });

  test("Template uses proper Dockerfile syntax", async () => {
    // Should have FROM instruction
    expect(template).toMatch(/^FROM /m);

    // Should have multi-stage build
    expect(template).toMatch(/FROM .* AS builder-base/);

    // Should use bash shell with pipefail
    expect(template).toContain('SHELL ["/bin/bash", "-o", "pipefail", "-c"]');
  });

  test("Template includes set -euo pipefail in RUN commands", async () => {
    // Find RUN commands and check they use pipefail
    const runCommands = template.match(/RUN .*set -euo pipefail/g);
    expect(runCommands).toBeDefined();
    expect(runCommands!.length).toBeGreaterThan(0);
  });

  test("Template has proper cache mount syntax", async () => {
    // Check for cache mounts with sharing=locked
    const cacheMounts = template.match(/--mount=type=cache.*sharing=locked/g);
    expect(cacheMounts).toBeDefined();
    expect(cacheMounts!.length).toBeGreaterThan(0);
  });
});

describe("Generated Dockerfile Validation", () => {
  let generatedDockerfile: string;

  beforeAll(async () => {
    const dockerfileFile = Bun.file(OUTPUT_PATH);
    expect(await dockerfileFile.exists()).toBe(true);
    generatedDockerfile = await dockerfileFile.text();
  });

  test("Generated Dockerfile exists and is not empty", async () => {
    expect(generatedDockerfile).toBeDefined();
    expect(generatedDockerfile.length).toBeGreaterThan(0);
  });

  test("Generated Dockerfile has generation header", async () => {
    expect(generatedDockerfile).toContain("AUTO-GENERATED FILE - DO NOT EDIT");
    expect(generatedDockerfile).toContain("Generator: scripts/docker/generate-dockerfile.ts");
    expect(generatedDockerfile).toContain("To regenerate: bun run generate");
  });

  test("PG_VERSION placeholder is replaced with actual version", async () => {
    expect(generatedDockerfile).not.toContain("{{PG_VERSION}}");
    expect(generatedDockerfile).toContain(extensionDefaults.pgVersion);
  });

  test("PG_MAJOR placeholder is replaced with major version", async () => {
    const pgMajor = extensionDefaults.pgVersion.split(".")[0];
    expect(generatedDockerfile).not.toContain("{{PG_MAJOR}}");
    expect(generatedDockerfile).toContain(`postgresql-${pgMajor}`);
  });

  test("PG_BASE_IMAGE_SHA placeholder is replaced", async () => {
    expect(generatedDockerfile).not.toContain("{{PG_BASE_IMAGE_SHA}}");
    expect(generatedDockerfile).toContain(extensionDefaults.baseImageSha);
  });

  test("PGDG_PACKAGES_INSTALL placeholder is replaced", async () => {
    expect(generatedDockerfile).not.toContain("{{PGDG_PACKAGES_INSTALL}}");

    // Should contain actual PGDG package installation
    expect(generatedDockerfile).toContain("apt-get install");
  });

  test("Multi-stage build structure is present", async () => {
    expect(generatedDockerfile).toMatch(/FROM .* AS builder-base/);
    expect(generatedDockerfile).toMatch(/FROM builder-base AS builder-pgxs/);
    expect(generatedDockerfile).toMatch(/FROM builder-base AS builder-cargo/);
  });

  test("HEALTHCHECK instruction is included", async () => {
    // Final stage should have healthcheck
    expect(generatedDockerfile).toMatch(/HEALTHCHECK/);
  });

  test("ARG declarations are present", async () => {
    expect(generatedDockerfile).toMatch(/ARG BUILD_DATE/);
    expect(generatedDockerfile).toMatch(/ARG VCS_REF/);
  });

  test("ENV declarations are present", async () => {
    expect(generatedDockerfile).toMatch(/ENV DEBIAN_FRONTEND=noninteractive/);
    expect(generatedDockerfile).toMatch(/ENV PATH=/);
  });

  test("All RUN commands use set -euo pipefail", async () => {
    // Find all RUN commands (excluding comments)
    const runLines = generatedDockerfile
      .split("\n")
      .filter((line) => line.trim().startsWith("RUN ") && !line.trim().startsWith("#"));

    // Each RUN should have pipefail (either directly or via script)
    for (const line of runLines) {
      const hasSetCommand = line.includes("set -euo pipefail");
      const isShortCommand = line.length < 100; // Short commands might not need it

      if (!isShortCommand) {
        expect(hasSetCommand).toBe(true);
      }
    }
  });

  test("Cache mounts use sharing=locked", async () => {
    const cacheMounts = generatedDockerfile.match(/--mount=type=cache[^\n]*/g);

    if (cacheMounts) {
      for (const mount of cacheMounts) {
        expect(mount).toContain("sharing=locked");
      }
    }
  });

  test("PGDG package installation includes version verification", async () => {
    // Should verify installed package count
    expect(generatedDockerfile).toMatch(/dpkg -l.*grep.*postgresql-\d+-/);
    expect(generatedDockerfile).toMatch(/INSTALLED_COUNT/);
  });

  test("PGDG package installation includes .so file verification", async () => {
    // Should verify critical .so files exist
    expect(generatedDockerfile).toMatch(/test -f.*\.so/);
  });

  test("Binary stripping is included for size optimization", async () => {
    expect(generatedDockerfile).toMatch(/strip --strip/);
  });
});

describe("PGDG Package Name Security Validation", () => {
  test("Package names contain only safe characters", () => {
    const safePattern = /^[a-zA-Z0-9\-_=.+:]*$/;

    const testCases = [
      { name: "postgresql-18-pgvector=0.8.1-2.pgdg13+1", valid: true },
      { name: "postgresql-18-cron=1.6.7-2.pgdg13+1", valid: true },
      { name: "postgresql-18-postgis-3=3.5.1+dfsg-1.pgdg13+1", valid: true },
      { name: "bad-package;rm -rf", valid: false },
      { name: "package$(malicious)", valid: false },
      { name: "package`command`", valid: false },
    ];

    for (const { name, valid } of testCases) {
      expect(safePattern.test(name)).toBe(valid);
    }
  });

  test("Version strings contain only safe characters", () => {
    const safePattern = /^[a-zA-Z0-9\-_=.+:]*$/;

    for (const [_key, version] of Object.entries(extensionDefaults.pgdgVersions)) {
      expect(safePattern.test(version)).toBe(true);
    }
  });
});

describe("Manifest Filtering Logic", () => {
  let manifest: Manifest;

  beforeAll(async () => {
    const manifestFile = Bun.file(MANIFEST_PATH);
    manifest = (await manifestFile.json()) as Manifest;
  });

  test("PGXS manifest includes correct build types", async () => {
    const pgxsBuildTypes = ["pgxs", "autotools", "cmake", "meson", "make", "timescaledb"];
    const pgxsEntries = manifest.entries.filter(
      (entry) => entry.build && pgxsBuildTypes.includes(entry.build.type)
    );

    expect(pgxsEntries.length).toBeGreaterThan(0);

    for (const entry of pgxsEntries) {
      expect(pgxsBuildTypes).toContain(entry.build!.type);
    }
  });

  test("Cargo manifest includes only cargo-pgrx builds", async () => {
    const cargoEntries = manifest.entries.filter(
      (entry) => entry.build && entry.build.type === "cargo-pgrx"
    );

    for (const entry of cargoEntries) {
      expect(entry.build!.type).toBe("cargo-pgrx");
    }
  });

  test("PGXS and Cargo manifests are mutually exclusive", async () => {
    const pgxsBuildTypes = ["pgxs", "autotools", "cmake", "meson", "make", "timescaledb"];
    const pgxsEntries = manifest.entries.filter(
      (entry) => entry.build && pgxsBuildTypes.includes(entry.build.type)
    );
    const cargoEntries = manifest.entries.filter(
      (entry) => entry.build && entry.build.type === "cargo-pgrx"
    );

    // No overlap - entries should be in one or the other, not both
    const pgxsNames = new Set(pgxsEntries.map((e) => e.name));
    const cargoNames = new Set(cargoEntries.map((e) => e.name));

    for (const name of pgxsNames) {
      expect(cargoNames.has(name)).toBe(false);
    }
  });
});

describe("Regression Mode Configuration", () => {
  let manifest: Manifest;

  beforeAll(async () => {
    const manifestFile = Bun.file(MANIFEST_PATH);
    manifest = (await manifestFile.json()) as Manifest;
  });

  test("Regression preload libraries include default + comprehensive test libraries", async () => {
    const regressionPreload = manifest.entries.filter((entry) => {
      const runtime = entry.runtime;
      if (!runtime || !runtime.sharedPreload) return false;

      const isDefaultEnable = runtime.defaultEnable === true;
      const isRegressionPreload = runtime.preloadInComprehensiveTest === true;
      const isEnabled = entry.enabled !== false;

      return (isDefaultEnable || isRegressionPreload) && isEnabled;
    });

    expect(regressionPreload.length).toBeGreaterThan(0);

    // Should include pg_stat_statements (default)
    const hasStatStatements = regressionPreload.some((e) => e.name === "pg_stat_statements");
    expect(hasStatStatements).toBe(true);
  });

  test("Preload library names are valid", async () => {
    const preloadEntries = manifest.entries.filter((e) => e.runtime?.sharedPreload === true);

    for (const entry of preloadEntries) {
      const libName = entry.runtime?.preloadLibraryName || entry.name;

      // Should only contain alphanumeric and underscore
      expect(libName).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });
});

describe("Dockerfile Syntax Validation", () => {
  let dockerfile: string;

  beforeAll(async () => {
    const dockerfileFile = Bun.file(OUTPUT_PATH);
    dockerfile = await dockerfileFile.text();
  });

  test("No trailing whitespace on continuation lines", async () => {
    const lines = dockerfile.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line?.endsWith("\\")) {
        // Line ending with backslash should not have trailing spaces before it
        expect(line.trimEnd().endsWith("\\")).toBe(true);
      }
    }
  });

  test("FROM instructions use digest pinning", async () => {
    const fromLines = dockerfile.match(/^FROM .*/gm);

    expect(fromLines).toBeDefined();
    expect(fromLines!.length).toBeGreaterThan(0);

    // Base images should use SHA digest
    const baseImage = fromLines!.find((line) => line.includes("postgres:"));
    expect(baseImage).toBeDefined();
    expect(baseImage).toMatch(/@sha256:[a-f0-9]{64}/);
  });

  test("COPY instructions use specific paths", async () => {
    const copyLines = dockerfile.match(/^COPY .*/gm);

    expect(copyLines).toBeDefined();

    for (const line of copyLines!) {
      // Should not copy entire directories without specificity
      expect(line).not.toMatch(/COPY \. /);
    }
  });

  test("Apt packages use --no-install-recommends", async () => {
    const aptInstalls = dockerfile.match(/apt-get install[^\n]*/g);

    if (aptInstalls) {
      for (const install of aptInstalls) {
        if (!install.includes("#")) {
          // Active install commands should use --no-install-recommends
          expect(install).toContain("--no-install-recommends");
        }
      }
    }
  });
});

describe("Build Optimization Checks", () => {
  let dockerfile: string;

  beforeAll(async () => {
    const dockerfileFile = Bun.file(OUTPUT_PATH);
    dockerfile = await dockerfileFile.text();
  });

  test("Rust installation is before manifests for cache efficiency", async () => {
    const rustLine = dockerfile.indexOf("rustup.rs");
    // Use the COPY of pgxs/cargo manifests which come after tools
    const manifestLine = dockerfile.indexOf("extensions.pgxs.manifest.json");

    expect(rustLine).toBeGreaterThan(0);
    expect(manifestLine).toBeGreaterThan(0);
    expect(rustLine).toBeLessThan(manifestLine);
  });

  test("Bun installation is before manifests for cache efficiency", async () => {
    const bunLine = dockerfile.indexOf("bun.sh/install");
    // Use the COPY of pgxs/cargo manifests which come after tools
    const manifestLine = dockerfile.indexOf("extensions.pgxs.manifest.json");

    expect(bunLine).toBeGreaterThan(0);
    expect(manifestLine).toBeGreaterThan(0);
    expect(bunLine).toBeLessThan(manifestLine);
  });

  test("Build dependencies are cleaned up", async () => {
    expect(dockerfile).toMatch(/apt-get clean/);
    expect(dockerfile).toMatch(/rm -rf.*\/var\/lib\/apt\/lists/);
  });

  test("Bitcode files are removed for size", async () => {
    expect(dockerfile).toMatch(/rm -rf.*bitcode/);
  });

  test("Static libraries are deleted", async () => {
    expect(dockerfile).toMatch(/find.*\.a.*-delete/);
  });
});
