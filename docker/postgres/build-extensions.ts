#!/usr/bin/env bun
/**
 * PostgreSQL Extension Build Orchestrator
 *
 * Orchestrates building 30+ PostgreSQL extensions with 8+ different build systems.
 * This is the MOST CRITICAL script in the codebase - handles cargo-pgrx version
 * management, git cloning with SHA verification, manifest parsing, and compilation.
 *
 * Build Systems Supported:
 * - pgxs: PostgreSQL Extension Build System
 * - cargo-pgrx: Rust pgrx framework (versioned)
 * - timescaledb: Custom bootstrap build
 * - autotools: ./configure && make
 * - cmake: CMake build
 * - meson: Meson build
 * - make: Generic make install
 * - script: Custom build scripts
 */

import { $ } from "bun";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// CRITICAL: PGDG EXTENSION BEHAVIOR
// ────────────────────────────────────────────────────────────────────────────
// Disabled PGDG extensions (install_via==pgdg AND enabled==false) are NOT built
// or apt-installed. They are filtered out in the Dockerfile's dynamic package
// selection (add_if_enabled function).
//
// This is expected behavior because:
// - PGDG extensions are pre-compiled binaries from apt, not source builds
// - The Dockerfile conditionally installs only enabled PGDG packages
// - This script never sees disabled PGDG extensions (they're skipped early)
// - Only compiled extensions (build.type specified) are built regardless of enabled status
//
// Result: Disabled PGDG extensions cannot be verified via build/test cycle.
// They are simply never installed in the image.
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ────────────────────────────────────────────────────────────────────────────

interface SourceSpec {
  type: "builtin" | "git" | "git-ref";
  repository?: string;
  commit?: string;
  tag?: string;
  ref?: string;
}

interface BuildSpec {
  type: "pgxs" | "cargo-pgrx" | "timescaledb" | "autotools" | "cmake" | "meson" | "make" | "script";
  subdir?: string;
  features?: string[];
  noDefaultFeatures?: boolean;
  script?: string;
  patches?: string[];
}

interface RuntimeSpec {
  sharedPreload?: boolean;
  defaultEnable?: boolean;
  preloadOnly?: boolean;
  notes?: string[];
}

interface ManifestEntry {
  name: string;
  displayName?: string;
  kind: "extension" | "tool" | "builtin";
  category: string;
  description: string;
  source: SourceSpec;
  build?: BuildSpec;
  runtime?: RuntimeSpec;
  dependencies?: string[];
  provides?: string[];
  aptPackages?: string[];
  notes?: string[];
  install_via?: "pgdg";
  enabled?: boolean;
  disabledReason?: string;
}

interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// Global State
// ────────────────────────────────────────────────────────────────────────────

const CARGO_PGRX_INIT = new Map<string, boolean>();

// Environment configuration
const MANIFEST_PATH = Bun.argv[2];
const BUILD_ROOT = Bun.argv[3] || "/tmp/extensions-build";
const PG_MAJOR = Bun.env.PG_MAJOR || "18";
const PG_CONFIG_BIN = Bun.env.PG_CONFIG || `/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config`;
const NPROC = await $`nproc`.text().then((s) => s.trim());

// Update PATH and cargo environment
process.env.PATH = `/root/.cargo/bin:${process.env.PATH}`;
process.env.CARGO_NET_GIT_FETCH_WITH_CLI = "true";

// ────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[ext-build] ${message}`);
}

async function ensureCleanDir(dir: string): Promise<void> {
  // Always remove directory if it exists (nothrow ignores error if it doesn't exist)
  // NOTE: Bun.file().exists() only works for files, not directories, so we use rm -rf
  await $`rm -rf ${dir}`.nothrow();
  await Bun.write(`${dir}/.gitkeep`, "");
}

// ────────────────────────────────────────────────────────────────────────────
// Git URL Validation
// ────────────────────────────────────────────────────────────────────────────

function validateGitUrl(url: string): void {
  const allowedDomains = ["github.com", "gitlab.com"];

  let domain = "";
  const httpsMatch = url.match(/^https?:\/\/([^/]+)/);
  const gitMatch = url.match(/^git@([^:]+):/);

  if (httpsMatch) {
    domain = httpsMatch[1];
  } else if (gitMatch) {
    domain = gitMatch[1];
  } else {
    log(`ERROR: Invalid git URL format: ${url}`);
    process.exit(1);
  }

  if (!allowedDomains.includes(domain)) {
    log(`ERROR: Git repository domain '${domain}' not in allowlist`);
    log(`Allowed domains: ${allowedDomains.join(", ")}`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Git Repository Cloning
// ────────────────────────────────────────────────────────────────────────────

async function cloneRepo(repo: string, commit: string, target: string): Promise<void> {
  // Validate URL before cloning (security: prevent arbitrary git clones)
  validateGitUrl(repo);

  log(`Cloning ${repo} @ ${commit} (shallow)`);

  // Shallow clone optimization: fetch only the specific commit (Phase 4.2)
  // Benefits: faster clone, reduced disk usage, smaller attack surface
  await $`git init ${target}`.quiet();
  await $`git -C ${target} remote add origin ${repo}`.quiet();

  // Try shallow fetch first, fallback to full fetch if server rejects
  try {
    await $`git -C ${target} fetch --depth 1 origin ${commit}`.quiet();
  } catch {
    log(`Shallow fetch failed, falling back to full fetch for ${commit}`);
    await $`git -C ${target} fetch origin ${commit}`.quiet();
  }

  await $`git -C ${target} checkout --quiet ${commit}`.quiet();

  // Initialize submodules if present
  if (await Bun.file(join(target, ".gitmodules")).exists()) {
    await $`git -C ${target} submodule update --init --recursive`.quiet();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cargo PGRX Version Management
// ────────────────────────────────────────────────────────────────────────────

async function ensureCargoPgrx(version: string): Promise<string> {
  const installRoot = `/root/.cargo-pgrx/${version}`;
  const cargoPgrxBin = join(installRoot, "bin", "cargo-pgrx");

  if (!(await Bun.file(cargoPgrxBin).exists())) {
    log(`Installing cargo-pgrx ${version}`);
    // Temporarily unset RUSTFLAGS to avoid conflicts with cargo-pgrx installation (Phase 11.1)
    // RUSTFLAGS optimization should only apply to extension builds, not build tools
    const savedRustflags = process.env.RUSTFLAGS;
    delete process.env.RUSTFLAGS;
    try {
      await $`cargo install --locked cargo-pgrx --version ${version} --root ${installRoot}`;
    } finally {
      if (savedRustflags !== undefined) {
        process.env.RUSTFLAGS = savedRustflags;
      }
    }
  }

  return installRoot;
}

async function ensurePgrxInitForVersion(installRoot: string, version: string): Promise<void> {
  if (CARGO_PGRX_INIT.get(version)) {
    return;
  }

  const pathEnv = `${installRoot}/bin:${process.env.PATH}`;

  // cargo pgrx init is idempotent - safe to run multiple times
  // Note: "cargo pgrx list" was removed in v0.16+, so we just run init unconditionally
  await $`env PATH=${pathEnv} cargo pgrx init --pg${PG_MAJOR} ${PG_CONFIG_BIN}`;

  CARGO_PGRX_INIT.set(version, true);
}

async function getPgrxVersion(dir: string): Promise<string> {
  const cargoFile = join(dir, "Cargo.toml");
  if (!(await Bun.file(cargoFile).exists())) {
    return "";
  }

  try {
    // Parse TOML using Bun's built-in parser
    const content = await Bun.file(cargoFile).text();
    const lines = content.split("\n");

    // Simple TOML parser for pgrx version (handles both inline and table formats)
    let inDependencies = false;
    for (const line of lines) {
      if (line.trim() === "[dependencies]") {
        inDependencies = true;
        continue;
      }
      if (line.trim().startsWith("[") && line.trim() !== "[dependencies]") {
        inDependencies = false;
        continue;
      }

      if (inDependencies && line.includes("pgrx")) {
        // Handle: pgrx = "0.16.1" or pgrx = { version = "0.16.1", ... }
        const versionMatch = line.match(/version\s*=\s*["']([^"']+)["']/);
        if (versionMatch) {
          let version = versionMatch[1];
          if (version.startsWith("=")) {
            version = version.substring(1);
          }
          return version;
        }

        // Handle simple string version: pgrx = "0.16.1"
        const simpleMatch = line.match(/pgrx\s*=\s*["']([^"']+)["']/);
        if (simpleMatch) {
          let version = simpleMatch[1];
          if (version.startsWith("=")) {
            version = version.substring(1);
          }
          return version;
        }
      }
    }

    return "";
  } catch (error) {
    log(`Warning: Failed to parse Cargo.toml in ${dir}: ${error}`);
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Build System Implementations
// ────────────────────────────────────────────────────────────────────────────

async function buildPgxs(dir: string): Promise<void> {
  log(`Running pgxs build in ${dir}`);
  await $`make -C ${dir} USE_PGXS=1 -j${NPROC}`;
  await $`make -C ${dir} USE_PGXS=1 install`;
}

async function buildCargoPgrx(dir: string, entry: ManifestEntry): Promise<void> {
  let version = await getPgrxVersion(dir);
  if (!version) {
    version = "0.16.1";
  }

  const installRoot = await ensureCargoPgrx(version);
  await ensurePgrxInitForVersion(installRoot, version);

  // Remove Cargo.lock to avoid conflicts
  const lockFile = join(dir, "Cargo.lock");
  if (await Bun.file(lockFile).exists()) {
    await $`rm -f ${lockFile}`;
  }

  const features = entry.build?.features || [];
  const noDefaultFeatures = entry.build?.noDefaultFeatures ? "--no-default-features" : "";

  log(`cargo pgrx ${version} install (${features.join(",") || "default"}) in ${dir}`);

  const pathEnv = `${installRoot}/bin:${process.env.PATH}`;

  // Use conditional template literals to handle --features flag properly
  // Bun's $ template requires separate arguments for flags, not array spreading
  if (features.length > 0 && noDefaultFeatures) {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN} --features ${features.join(",")} ${noDefaultFeatures}`.env(
      { PATH: pathEnv }
    );
  } else if (features.length > 0) {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN} --features ${features.join(",")}`.env(
      { PATH: pathEnv }
    );
  } else if (noDefaultFeatures) {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN} ${noDefaultFeatures}`.env(
      { PATH: pathEnv }
    );
  } else {
    await $`cd ${dir} && cargo pgrx install --release --pg-config ${PG_CONFIG_BIN}`.env({
      PATH: pathEnv,
    });
  }
}

async function buildTimescaledb(dir: string): Promise<void> {
  log(`Building TimescaleDB via bootstrap in ${dir}`);

  // Build with TSL (Timescale License) enabled for compression and continuous aggregates
  // APACHE_ONLY=OFF (default) includes TSL features
  // TSL is free for self-hosted use (including SaaS)
  // Note: Downgrade scripts disabled - not needed for Docker builds (shallow git clone)
  await $`cd ${dir} && ./bootstrap -DAPACHE_ONLY=OFF -DREGRESS_CHECKS=OFF`;

  const buildDir = join(dir, "build");
  const ninjaFile = join(buildDir, "build.ninja");

  if (await Bun.file(ninjaFile).exists()) {
    await $`cd ${buildDir} && ninja -j${NPROC} && ninja install`;
  } else {
    await $`cd ${buildDir} && make -j${NPROC}`;
    await $`cd ${buildDir} && make install`;
  }

  await Bun.write(`/usr/share/postgresql/${PG_MAJOR}/timescaledb/.gitkeep`, "");
}

async function buildAutotools(dir: string, name: string): Promise<void> {
  log(`Running autotools build for ${name} in ${dir}`);

  const autogenScript = join(dir, "autogen.sh");
  if (await Bun.file(autogenScript).exists()) {
    await $`cd ${dir} && ./autogen.sh`;
  }

  const configureArgs = [`--with-pgconfig=${PG_CONFIG_BIN}`];
  if (name === "postgis") {
    configureArgs.push("--with-protobuf=yes", "--with-pcre=yes");
  }

  await $`cd ${dir} && ./configure ${configureArgs}`;
  await $`cd ${dir} && make -j${NPROC}`;
  await $`cd ${dir} && make install`;
}

async function buildCmake(dir: string, name: string): Promise<void> {
  const buildDir = join(dir, ".cmake-build");
  log(`Running CMake build for ${name} in ${dir}`);

  await $`cmake -S ${dir} -B ${buildDir} -DCMAKE_BUILD_TYPE=Release`;
  await $`cmake --build ${buildDir} -j${NPROC}`;
  await $`cmake --install ${buildDir}`;
}

async function buildMeson(dir: string): Promise<void> {
  const buildDir = join(dir, ".meson-build");
  log(`Running Meson build in ${dir}`);

  await $`meson setup ${buildDir} ${dir} --prefix=/usr/local`;
  await $`ninja -C ${buildDir} -j${NPROC}`;
  await $`ninja -C ${buildDir} install`;
}

async function buildMakeGeneric(dir: string): Promise<void> {
  log(`Running generic make install in ${dir}`);
  await $`cd ${dir} && make -j${NPROC}`;
  await $`cd ${dir} && make install`;
}

async function buildPgbadger(dir: string): Promise<void> {
  log(`Building pgbadger (Perl) in ${dir}`);
  await $`cd ${dir} && perl Makefile.PL`;
  await $`cd ${dir} && make -j${NPROC}`;
  await $`cd ${dir} && make install`;
}

// ────────────────────────────────────────────────────────────────────────────
// GATE 1: DEPENDENCY VALIDATION
// ────────────────────────────────────────────────────────────────────────────
// Validates that all dependencies for an extension are enabled.
// Fails fast with clear error message if any dependency is missing or disabled.

async function validateDependencies(
  entry: ManifestEntry,
  name: string,
  manifest: Manifest
): Promise<void> {
  const dependencies = entry.dependencies || [];
  if (dependencies.length === 0) {
    return;
  }

  log(`Validating ${dependencies.length} dependencies for ${name}`);

  for (const depName of dependencies) {
    // Check if dependency exists and is enabled in current manifest
    const depEntry = manifest.entries.find((e) => e.name === depName);

    if (!depEntry) {
      // Dependency not in current manifest - check full manifest (cross-build-type dependencies)
      const fullManifestPath = "/tmp/extensions.manifest.json";
      if (await Bun.file(fullManifestPath).exists()) {
        const fullManifest = (await Bun.file(fullManifestPath).json()) as Manifest;
        const depEntryFull = fullManifest.entries.find((e) => e.name === depName);

        if (depEntryFull) {
          // Check if dependency is enabled in full manifest
          const depEnabledInFull = depEntryFull.enabled !== false;
          if (!depEnabledInFull) {
            const depReason = depEntryFull.disabledReason || "No reason specified";
            log(`ERROR: Extension ${name} requires dependency '${depName}' which is disabled`);
            log(`       Dependency disabled reason: ${depReason}`);
            log(`       Either enable '${depName}' or disable '${name}'`);
            process.exit(1);
          }

          // Dependency exists and is enabled - accept regardless of how it's built
          if (depEntryFull.install_via === "pgdg") {
            log(`  ✓ Dependency '${depName}' will be installed via PGDG`);
          } else if (depEntryFull.install_via === "source") {
            log(`  ✓ Dependency '${depName}' will be built from source (different build phase)`);
          } else if (depEntryFull.kind === "builtin") {
            log(`  ✓ Dependency '${depName}' is builtin (included in PostgreSQL)`);
          } else {
            log(`  ✓ Dependency '${depName}' will be built from source`);
          }
          continue;
        }
      }

      log(`ERROR: Extension ${name} requires dependency '${depName}' which is not in manifest`);
      process.exit(1);
    }

    const depEnabled = depEntry.enabled !== false;
    if (!depEnabled) {
      const depReason = depEntry.disabledReason || "No reason specified";
      log(`ERROR: Extension ${name} requires dependency '${depName}' which is disabled`);
      log(`       Dependency disabled reason: ${depReason}`);
      log(`       Either enable '${depName}' or disable '${name}'`);
      process.exit(1);
    }

    log(`  ✓ Dependency '${depName}' is enabled`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Patch Application
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert sed substitution pattern to JavaScript regex and replacement
 * Handles common sed patterns: s/pattern/replacement/flags
 */
function parseSedPattern(sedPattern: string): { pattern: RegExp; replacement: string } | null {
  // Match sed substitution format: s/pattern/replacement/flags
  const match = sedPattern.match(/^s\/(.+?)\/(.+?)\/?([gimsu]*)$/);
  if (!match) {
    return null;
  }

  const [, pattern, replacement, flags] = match;

  // Convert sed regex to JavaScript regex
  let jsPattern = pattern
    // Convert POSIX character classes to JS equivalents
    .replace(/\[:space:\]/g, "\\s")
    .replace(/\[:alnum:\]/g, "[A-Za-z0-9]")
    .replace(/\[:alpha:\]/g, "[A-Za-z]")
    .replace(/\[:digit:\]/g, "\\d")
    // Convert sed quantifiers {n,m} to JS
    .replace(/\\{(\d+),?(\d*)\\}/g, "{$1,$2}")
    // Handle start of line anchor
    .replace(/^\^/, "^\\s*") // Allow optional leading whitespace
    // Unescape dots
    .replace(/\\\./g, ".");

  // For multiline matching, add 'm' flag if pattern has ^ or $
  const jsFlags = (flags || "") + (pattern.includes("^") || pattern.includes("$") ? "m" : "");

  try {
    const regex = new RegExp(jsPattern, jsFlags);
    return { pattern: regex, replacement };
  } catch {
    return null;
  }
}

/**
 * Apply a sed-style patch to file content using Bun native operations
 */
async function applySedPatch(filePath: string, sedPattern: string): Promise<boolean> {
  const parsed = parseSedPattern(sedPattern);
  if (!parsed) {
    log(`    Warning: Could not parse sed pattern: ${sedPattern}`);
    return false;
  }

  const { pattern, replacement } = parsed;

  // Read file content
  const originalContent = await Bun.file(filePath).text();

  // Apply substitution
  const modifiedContent = originalContent.replace(pattern, replacement);

  // Check if any changes were made
  if (originalContent === modifiedContent) {
    return false;
  }

  // Write modified content back
  await Bun.write(filePath, modifiedContent);
  return true;
}

async function applyPatches(entry: ManifestEntry, dest: string, name: string): Promise<void> {
  const patches = entry.build?.patches || [];
  if (patches.length === 0) {
    return;
  }

  log(`Applying ${patches.length} patch(es) for ${name}`);

  // Track modification timestamps for each file before patching
  const modificationTimes = new Map<string, number>();

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    log(`  Patch ${i + 1}: ${patch}`);

    // Find all files to patch based on extension type
    let targetFiles: string[] = [];

    if (patch.includes("Cargo.toml") || entry.build?.type === "cargo-pgrx") {
      // For Cargo projects, find all Cargo.toml files
      const result = await $`find ${dest} -name "Cargo.toml" -type f`.text();
      targetFiles = result.trim().split("\n").filter(Boolean);
    } else if (patch.includes(".c")) {
      // For C projects, find specific C files mentioned in patch or all .c files
      if (patch.includes("log_skipped_evtrigs")) {
        // Anchor to specific file for supautils patch
        const result = await $`find ${dest} -name "supautils.c" -type f`.text();
        targetFiles = result.trim().split("\n").filter(Boolean);
      } else {
        const result = await $`find ${dest} -name "*.c" -type f`.text();
        targetFiles = result.trim().split("\n").filter(Boolean);
      }
    } else {
      // Default: apply to all files in dest
      targetFiles = [dest];
    }

    // Apply patch to each target file using Bun native operations
    for (const targetFile of targetFiles) {
      if (await Bun.file(targetFile).exists()) {
        // Record pre-patch modification time
        const stat = await Bun.file(targetFile).stat();
        modificationTimes.set(targetFile, stat.mtime.getTime());

        const patched = await applySedPatch(targetFile, patch);
        if (!patched) {
          log(`    Warning: patch did not match in ${targetFile}`);
        }
      }
    }
  }

  // Log patched files by comparing modification times
  log("Patched files:");
  const patchedFiles: string[] = [];

  for (const [filePath, oldMtime] of modificationTimes) {
    if (await Bun.file(filePath).exists()) {
      const stat = await Bun.file(filePath).stat();
      if (stat.mtime.getTime() > oldMtime) {
        const relativePath = filePath.replace(dest + "/", "");
        patchedFiles.push(relativePath);
      }
    }
  }

  if (patchedFiles.length > 0) {
    for (const pf of patchedFiles) {
      log(`  - ${pf}`);
    }
  } else {
    log("  (no files modified - patches may not have matched)");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main Entry Processing
// ────────────────────────────────────────────────────────────────────────────

async function processEntry(entry: ManifestEntry, manifest: Manifest): Promise<void> {
  const { name, kind, source, build, enabled } = entry;

  if (kind === "builtin") {
    log(`Skipping builtin extension ${name}`);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // GATE 0: ENABLED CHECK
  // ────────────────────────────────────────────────────────────────────────────
  // Behavior:
  // - Disabled extensions: Skipped entirely (not built, not included in final image)
  // - Enabled extensions: Built, tested, included in final image
  if (enabled === false) {
    const disabledReason = entry.disabledReason || "No reason specified";
    log(`Extension ${name} disabled (reason: ${disabledReason}) - skipping build`);
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // GATE 1: PGDG SKIP CHECK (Phase 4.4 - moved after enabled check)
  // ────────────────────────────────────────────────────────────────────────────
  // Skip PGDG extensions here because they're installed via apt-get in Dockerfile
  // Note: This happens AFTER enabled check so disabled PGDG extensions are tracked
  if (entry.install_via === "pgdg") {
    log(`Skipping ${name} (installed via PGDG)`);
    return;
  }

  const dest = join(BUILD_ROOT, name);
  await ensureCleanDir(dest);

  // Clone repository based on source type
  if (source.type === "git" && source.repository && source.tag) {
    // Resolve tag to commit SHA
    const tempDir = join(BUILD_ROOT, `${name}-temp`);
    // Remove temp directory if it exists (git clone requires target to not exist)
    await $`rm -rf ${tempDir}`.nothrow();

    validateGitUrl(source.repository);
    await $`git clone --depth 1 --branch ${source.tag} ${source.repository} ${tempDir}`.quiet();
    const commit = await $`git -C ${tempDir} rev-parse HEAD`.text().then((s) => s.trim());
    await $`rm -rf ${tempDir}`;

    await cloneRepo(source.repository, commit, dest);
  } else if (source.type === "git-ref" && source.repository && (source.ref || source.commit)) {
    const commit = source.commit || source.ref!;
    await cloneRepo(source.repository, commit, dest);
  } else if (source.type === "builtin") {
    return;
  } else {
    log(`Unknown source type ${source.type} for ${name}`);
    process.exit(1);
  }

  // Apply patches if specified
  await applyPatches(entry, dest, name);

  // Determine working directory
  const workdir = build?.subdir ? join(dest, build.subdir) : dest;

  // Validate dependencies before building
  await validateDependencies(entry, name, manifest);

  // Build extension based on build type
  const buildType = build?.type;
  if (!buildType) {
    log(`No build type specified for ${name}`);
    return;
  }

  switch (buildType) {
    case "pgxs":
      await buildPgxs(workdir);
      break;

    case "cargo-pgrx":
      await buildCargoPgrx(workdir, entry);
      if (name === "timescaledb_toolkit") {
        log("Running toolkit post-install hook");
        await $`cd ${dest} && cargo run --manifest-path tools/post-install/Cargo.toml -- pg_config`;
      }
      break;

    case "timescaledb":
      await buildTimescaledb(workdir);
      break;

    case "autotools":
      await buildAutotools(workdir, name);
      break;

    case "cmake":
      await buildCmake(workdir, name);
      break;

    case "meson":
      await buildMeson(workdir);
      break;

    case "make":
      if (name === "pgbadger") {
        await buildPgbadger(workdir);
      } else {
        await buildMakeGeneric(workdir);
      }
      break;

    case "script":
      log(`Custom script build type not implemented for ${name}`);
      process.exit(1);
      break;

    default:
      log(`Unsupported build type ${buildType} for ${name}`);
      process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main Execution
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!MANIFEST_PATH) {
    console.error("Usage: build-extensions.ts <manifest-path> [build-root]");
    process.exit(1);
  }

  if (!(await Bun.file(MANIFEST_PATH).exists())) {
    log(`ERROR: Manifest file not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  // Load and parse manifest
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as Manifest;

  // Create build root directory
  await Bun.write(`${BUILD_ROOT}/.gitkeep`, "");

  // Process each entry in the manifest
  for (const entry of manifest.entries) {
    await processEntry(entry, manifest);
  }

  log("Extension build complete");
}

// Run main function
main().catch((error) => {
  log(`FATAL ERROR: ${error.message}`);
  console.error(error);
  process.exit(1);
});
